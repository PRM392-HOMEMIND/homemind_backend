/**
 * Cache trong bộ nhớ cho dữ liệu đọc theo (người dùng, workspace).
 *
 * Vì sao cần: DB nằm xa backend nên mỗi truy vấn tốn ~100–350ms. Một màn hình
 * cần nhiều truy vấn nên chậm cả giây. Dữ liệu đọc được giữ ngắn hạn trong bộ
 * nhớ và bị xoá NGAY khi có thao tác ghi vào workspace đó, nên người dùng
 * không bao giờ thấy dữ liệu cũ sau khi chính mình (hoặc thành viên khác
 * qua cùng backend) vừa ghi.
 *
 * - Gộp các lần tải đồng thời cùng khoá thành một truy vấn (chống "bão" request).
 * - TTL ngắn làm lưới an toàn khi dữ liệu bị đổi từ nơi khác (SQL trực tiếp).
 * - Chạy một tiến trình. Nếu chạy nhiều bản backend, thay lớp này bằng Redis
 *   và phát sự kiện huỷ cache; giao diện (get/invalidate) giữ nguyên.
 */
type Entry<T> = { at: number; value: T };

// Mọi cache tự đăng ký để một lệnh `invalidateWorkspace` xoá được tất cả.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registered = new Set<WorkspaceCache<any>>();

/** Gọi sau (và trước) mỗi thao tác ghi vào workspace để không bao giờ đọc lại dữ liệu cũ. */
export function invalidateWorkspace(workspaceId: string): void {
  for (const cache of registered) cache.invalidate(workspaceId);
}

export class WorkspaceCache<T> {
  private readonly values = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly byWorkspace = new Map<string, Set<string>>();
  /** Opaque generation identity cannot become equal again after eviction/recreation. */
  private readonly generation = new Map<string, object>();

  constructor(private readonly ttlMs = 30_000, private readonly maxEntries = 2_000) {
    registered.add(this);
  }

  private key(userId: string, workspaceId: string): string {
    return `${workspaceId}|${userId}`;
  }

  peek(userId: string, workspaceId: string): T | undefined {
    const entry = this.values.get(this.key(userId, workspaceId));
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) return undefined;
    return entry.value;
  }

  async get(userId: string, workspaceId: string, load: () => Promise<T>): Promise<T> {
    const key = this.key(userId, workspaceId);
    const hit = this.peek(userId, workspaceId);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const startedGeneration = this.generation.get(workspaceId) ?? {};
    this.generation.set(workspaceId,startedGeneration);
    const promise = Promise.resolve().then(load).then(value=>{
        // Nếu giữa lúc tải có thao tác ghi (đã huỷ cache) thì dữ liệu này có thể
        // đã cũ: trả về cho người gọi nhưng KHÔNG lưu lại.
        if (this.generation.get(workspaceId) === startedGeneration) this.set(userId, workspaceId, value);
        return value;
      }).finally(()=>{
        if(this.inflight.get(key)===promise)this.inflight.delete(key);
        this.pruneGeneration(workspaceId);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  set(userId: string, workspaceId: string, value: T): void {
    const key = this.key(userId, workspaceId);
    if (this.values.size >= this.maxEntries) this.evictOldest();
    this.values.set(key, { at: Date.now(), value });
    let keys = this.byWorkspace.get(workspaceId);
    if (!keys) this.byWorkspace.set(workspaceId, (keys = new Set()));
    keys.add(key);
  }

  /** Cập nhật tại chỗ giá trị đã có (ví dụ đánh dấu đã đọc) mà không phải tải lại. */
  update(userId: string, workspaceId: string, change: (value: T) => T): void {
    const key = this.key(userId, workspaceId);
    const entry = this.values.get(key);
    if (entry) this.values.set(key, { at: entry.at, value: change(entry.value) });
  }

  /** Xoá mọi dữ liệu của workspace (gọi sau mỗi thao tác ghi). */
  invalidate(workspaceId: string): void {
    this.generation.delete(workspaceId);
    for(const key of this.inflight.keys())if(key.startsWith(workspaceId+'|'))this.inflight.delete(key);
    const keys = this.byWorkspace.get(workspaceId);
    if (keys) {
      for (const key of keys) this.values.delete(key);
      this.byWorkspace.delete(workspaceId);
    }
  }

  clear(): void {
    this.values.clear();
    this.inflight.clear();
    this.byWorkspace.clear();
    this.generation.clear();
  }
  dispose():void {this.clear();registered.delete(this);}
  private pruneGeneration(workspace:string){
    if(!this.byWorkspace.has(workspace)&&![...this.inflight.keys()].some(key=>key.startsWith(workspace+'|')))this.generation.delete(workspace);
  }

  get size(): number {
    return this.values.size;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of this.values) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.values.delete(oldestKey);
      const workspace=oldestKey.split('|')[0],keys=this.byWorkspace.get(workspace);keys?.delete(oldestKey);
      if(!keys?.size)this.byWorkspace.delete(workspace);
      this.pruneGeneration(workspace);
    }
  }
}
