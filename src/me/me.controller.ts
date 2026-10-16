import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { ApiCommonErrors } from '../common/openapi.decorators';
import { MeResponseDto } from '../common/openapi.dto';
import { UpdateProfileDto } from '../common/dto';
import { DatabaseService, UserTx } from '../database/database.service';

@ApiTags('me') @ApiBearerAuth() @ApiCommonErrors() @UseGuards(AuthGuard) @Controller('me')
export class MeController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @ApiOperation({ summary: 'Thông tin người dùng và household mặc định' })
  @ApiOkResponse({ type: MeResponseDto })
  async get(@Req() request: AuthRequest) {
    return this.load(request);
  }

  @Patch()
  @ApiOperation({ summary: 'Cập nhật tên, số điện thoại, địa chỉ, ngôn ngữ của chính mình' })
  @ApiOkResponse({ type: MeResponseDto })
  async update(@Req() request: AuthRequest, @Body() body: UpdateProfileDto) {
    const clean = (value: string | null | undefined) => (value === undefined ? undefined : (value?.trim() || null));
    const data = {
      ...(body.displayName !== undefined ? { displayName: body.displayName.trim() } : {}),
      ...(body.phone !== undefined ? { phone: clean(body.phone) } : {}),
      ...(body.address !== undefined ? { address: clean(body.address) } : {}),
      ...(body.language !== undefined ? { language: body.language } : {}),
    };
    return this.db.asUser(request.userId, async tx => {
      // A failed response load rolls the profile write back in the same transaction.
      if (Object.keys(data).length) {
        await tx.profile.update({ where: { id: request.userId }, data: { ...data, updatedAt: new Date() } });
      }
      return this.loadIn(request, tx);
    });
  }

  private async load(request: AuthRequest) {
    return this.db.asUser(request.userId, tx => this.loadIn(request, tx));
  }

  private async loadIn(request: AuthRequest, tx: UserTx) {
    const rows = await tx.$queryRaw<Array<{
      email: string | null; login_phone: string | null; display_name: string; phone: string | null;
      address: string | null; language: string; workspace_id: string; workspace_name: string;
      workspace_type: string; role: string; plan: string; product_limit: number | null;
    }>>`
      select u.email,u.phone as login_phone,p.display_name,p.phone,p.address,p.language,
        w.id as workspace_id,w.name as workspace_name,w.type as workspace_type,m.role,e.plan,e."productLimit" as product_limit
      from public.users u join public.profiles p on p.id=u.id
      join public.workspace_members m on m.user_id=u.id
      join public.workspaces w on w.id=m.workspace_id and w.archived_at is null
      join lateral jsonb_to_record(public.billing_effective(w.id)) as e(plan text,"productLimit" integer) on true
      where u.id=${request.userId}::uuid and u.status='ACTIVE' and w.id=public.workspace_context()
      order by (m.role='owner') desc,m.created_at,w.id limit 1`;
    const row = rows[0];
    if (!row) throw new Error('NOT_FOUND');
    return {
      userId: request.userId, email: row.email ?? '', loginPhone: row.login_phone,
      displayName: row.display_name, phone: row.phone, address: row.address, language: row.language,
      workspaceId: row.workspace_id, workspaceName: row.workspace_name, workspaceType: row.workspace_type,
      role: row.role, plan: row.plan ?? 'free', productLimit: row.product_limit,
      voiceQuota: (await tx.$queryRaw<Array<{ quota: Record<string, unknown> }>>`
        select public.assistant_quota_get(${row.workspace_id}::uuid) as quota`)[0].quota,
    };
  }
}
