"""Root-only, inactive provider revisions; no DB/auth/signing rotation.

Staging is an operator action on bounded stdin, never an SSH deploy-key command.
Only a manifest-authorized deployment can activate a staged revision. Values and
private file hashes never appear in release records or command output.
"""
import hashlib, json, os, pathlib, re, secrets, stat, tempfile
from urllib.parse import urlsplit

REVISION = re.compile(r'^env-[a-f0-9]{32}$')
GEMINI_FIELDS = {'GEMINI_API_KEY', 'GEMINI_MODEL'}
PAYOS_FIELDS = {'PAYOS_ENABLED', 'PAYOS_CLIENT_ID', 'PAYOS_API_KEY',
                'PAYOS_CHECKSUM_KEY', 'BILLING_ORDER_NAMESPACE'}
FIELDS = GEMINI_FIELDS | PAYOS_FIELDS
ADMIN_FIELDS = {'ADMIN_DATABASE_URL', 'ADMIN_WEB_ORIGINS'}
EMAIL_FIELDS = {'EMAIL_DELIVERY_MODE', 'AUTH_OTP_SECRET', 'INFOBIP_API_KEY', 'INFOBIP_BASE_URL', 'INFOBIP_EMAIL_FROM'}
AUTH_FIELDS = {'AUTH_ACCESS_SECRET', 'AUTH_REFRESH_SECRET', 'AUTH_RESET_SECRET'}

def valid_revision(value):
    if not isinstance(value, str) or not REVISION.fullmatch(value):
        raise ValueError('Invalid environment revision')
    return value

class Revisions:
    def __init__(self, root=pathlib.Path('/etc/homemind')):
        self.root = pathlib.Path(root)
        self.uid = os.geteuid()
        if self.uid != 0:
            raise ValueError('Environment revision operations require the existing root operator')
        self.directory(self.root)
        self.revisions = self.root / 'revisions'
        if not self.revisions.exists(): self.revisions.mkdir(mode=0o700)
        self.directory(self.revisions)

    def directory(self, path):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != self.uid or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('Unsafe environment directory ownership or permissions')

    def read(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != self.uid or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 65536:
                raise ValueError('Unsafe environment file ownership, permissions or size')
            with os.fdopen(fd, 'rb', closefd=False) as source: return source.read(65537)
        finally: os.close(fd)

    def atomic(self, path, data):
        self.directory(path.parent)
        if path.exists() or path.is_symlink(): self.read(path)
        fd, name = tempfile.mkstemp(prefix='.env-revision-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as writer:
                os.fchmod(writer.fileno(), 0o600)
                writer.write(data); writer.flush(); os.fsync(writer.fileno())
            os.replace(name, path)
            descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(descriptor)
            finally: os.close(descriptor)
        finally:
            if os.path.exists(name): os.unlink(name)

    def stage(self, changes):
        self.current()  # An unfinished recovery cannot become a new staging base.
        before = self.read(self.root / 'api.env')
        self.validate_changes(before, changes)
        revision = 'env-' + secrets.token_hex(16)
        self.atomic(self.revisions / (revision + '.json'), json.dumps({
            'revision': revision, 'base': hashlib.sha256(before).hexdigest(), 'changes': changes,
        }).encode())
        return revision

    def validate_changes(self, before, changes):
        if not isinstance(changes, dict) or set(changes) not in [GEMINI_FIELDS, PAYOS_FIELDS, FIELDS, ADMIN_FIELDS, EMAIL_FIELDS]:
            raise ValueError('Only complete authorized provider/admin groups may be staged')
        if any(not isinstance(value, str) or '\n' in value or '\r' in value for value in changes.values()):
            raise ValueError('Unsafe environment revision value')
        configured = {}
        for line in before.decode().splitlines():
            if '=' not in line or line.lstrip().startswith('#'): continue
            key, value = line.split('=', 1)
            if key in FIELDS | ADMIN_FIELDS | EMAIL_FIELDS | AUTH_FIELDS | {'DATABASE_URL'}:
                if key in configured: raise ValueError('Duplicate provider environment fields')
                configured[key] = value
        if set(changes) == EMAIL_FIELDS:
            if changes['EMAIL_DELIVERY_MODE'] not in ['disabled', 'infobip']:
                raise ValueError('Invalid email delivery mode')
            target = urlsplit(changes['INFOBIP_BASE_URL'])
            if (target.scheme != 'https' or not re.fullmatch(r'[a-z0-9-]+\.api\.infobip\.com', target.hostname or '')
                    or target.username or target.password or target.path or target.query or target.fragment
                    or changes['INFOBIP_BASE_URL'] != 'https://' + target.netloc):
                raise ValueError('Invalid Infobip account origin')
            if (not re.fullmatch(r'[A-Za-z0-9_.-]{20,256}', changes['INFOBIP_API_KEY'])
                    or re.search(r'change.?me|placeholder|replace.?me', changes['INFOBIP_API_KEY'], re.I)):
                raise ValueError('Invalid email provider credential')
            if not re.fullmatch(r'[a-f0-9]{64,128}', changes['AUTH_OTP_SECRET']):
                raise ValueError('Invalid independent OTP secret')
            if changes['AUTH_OTP_SECRET'] in [configured.get(key) for key in AUTH_FIELDS | FIELDS | {'INFOBIP_API_KEY'}] or changes['AUTH_OTP_SECRET'] == changes['INFOBIP_API_KEY']:
                raise ValueError('OTP secret must be independent')
            if configured.get('AUTH_OTP_SECRET') and configured['AUTH_OTP_SECRET'] != changes['AUTH_OTP_SECRET']:
                raise ValueError('Email provisioning cannot rotate an existing OTP secret')
            sender = changes['INFOBIP_EMAIL_FROM']
            if len(sender) > 254 or sender != sender.lower() or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}", sender):
                raise ValueError('Invalid email sender')
        if set(changes) == ADMIN_FIELDS:
            target = urlsplit(changes['ADMIN_DATABASE_URL'])
            ordinary = urlsplit(configured.get('DATABASE_URL', ''))
            if (target.scheme != 'postgresql' or target.username != 'homemind_admin_api'
                    or not target.password or not re.fullmatch(r'[a-f0-9]{64}', target.password)
                    or (target.hostname,target.port,target.path) != (ordinary.hostname,ordinary.port,ordinary.path)
                    or target.query or target.fragment):
                raise ValueError('Invalid dedicated admin database configuration')
            origins = changes['ADMIN_WEB_ORIGINS'].split(',')
            if not 1 <= len(origins) <= 5 or len(set(origins)) != len(origins):
                raise ValueError('Invalid admin origins')
            for origin in origins:
                url = urlsplit(origin)
                if (url.scheme != 'https' or not url.hostname or url.username or url.password
                        or url.path or url.query or url.fragment or '*' in origin
                        or origin != 'https://' + url.netloc):
                    raise ValueError('Admin origin must be an exact HTTPS origin')
        if GEMINI_FIELDS <= set(changes):
            if not re.fullmatch(r'[A-Za-z0-9_.-]{20,256}', changes['GEMINI_API_KEY']):
                raise ValueError('Missing or unsafe Gemini credential')
            if not re.fullmatch(r'gemini-[A-Za-z0-9.-]{1,100}', changes['GEMINI_MODEL']):
                raise ValueError('Invalid Gemini model')
            if configured.get('GEMINI_MODEL') != changes['GEMINI_MODEL']:
                raise ValueError('Staging cannot change the existing Gemini model')
        if PAYOS_FIELDS <= set(changes):
            if changes['PAYOS_ENABLED'] not in ['true', 'false']:
                raise ValueError('Invalid payment enablement')
            for key in ['PAYOS_CLIENT_ID', 'PAYOS_API_KEY', 'PAYOS_CHECKSUM_KEY']:
                value = changes[key]
                if (not re.fullmatch(r'[A-Za-z0-9_.-]{20,256}', value)
                        or re.search(r'change.?me|placeholder|replace.?me', value, re.I)):
                    raise ValueError('Missing or unsafe payment credential')
            namespace = changes['BILLING_ORDER_NAMESPACE']
            if not re.fullmatch(r'[1-9][0-9]{0,2}', namespace) or not 2 <= int(namespace) <= 999:
                raise ValueError('Invalid production order namespace')
            # Production's existing/default namespace is not the local test
            # namespace. A config reload must never reuse or move order codes.
            if configured.get('BILLING_ORDER_NAMESPACE', '2') != namespace:
                raise ValueError('Staging cannot change the production order namespace')
            client = configured.get('PAYOS_CLIENT_ID', '')
            if client and client != changes['PAYOS_CLIENT_ID']:
                raise ValueError('Staging cannot change the existing payment merchant')
        return changes

    def candidate(self, revision):
        valid_revision(revision)
        before = self.read(self.root / 'api.env')
        if self.current() == revision:
            journal=json.loads(self.read(self.revisions / (revision + '.rollback.json')))
            if journal['after'] != hashlib.sha256(before).hexdigest():
                raise ValueError('Active environment changed outside its approved revision')
            return before, before
        record = json.loads(self.read(self.revisions / (revision + '.json')))
        if record.get('revision') != revision or record.get('base') != hashlib.sha256(before).hexdigest():
            raise ValueError('Environment revision is stale or does not match the current environment')
        changes = record['changes']
        return before, self.render(before, changes)

    def render(self, before, changes):
        self.validate_changes(before, changes)
        # Preserve comments, ordering and every line outside the requested group.
        seen = set(); lines = []
        for line in before.decode().splitlines(keepends=True):
            key = line.split('=', 1)[0] if '=' in line and not line.lstrip().startswith('#') else ''
            if key in changes:
                if key in seen: raise ValueError('Duplicate provider environment fields')
                seen.add(key); lines.append(key + '=' + changes[key] + '\n')
            else: lines.append(line)
        if set(changes) - seen and lines and not lines[-1].endswith('\n'):
            raise ValueError('Cannot append provider fields without changing an unrelated line')
        lines += [key + '=' + changes[key] + '\n' for key in sorted(set(changes) - seen)]
        return ''.join(lines).encode()

    def resume_activation(self, revision):
        """Explicit forward recovery only; leave the marker until healthy commit."""
        valid_revision(revision)
        if self.activation_pending()!=revision or self.pending() or self.bootstrap_pending():
            raise ValueError('Forward activation does not match the pending journal')
        journal=json.loads(self.read(self.revisions / (revision + '.rollback.json')))
        staged=json.loads(self.read(self.revisions / (revision + '.json')))
        before=journal['before'].encode()
        if staged.get('revision')!=revision or staged.get('base')!=hashlib.sha256(before).hexdigest():
            raise ValueError('Forward environment staging identity mismatch')
        after=self.render(before, staged['changes'])
        current=self.read(self.root / 'api.env')
        if hashlib.sha256(after).hexdigest()!=journal['after'] or current not in [before,after]:
            raise ValueError('Environment bytes changed outside the pending activation')
        if self.active() not in [journal['prior'],revision]:
            raise ValueError('Active environment revision changed after interruption')
        if current!=after:self.atomic(self.root / 'api.env',after)
        self.atomic(self.root / 'active-env-revision',(revision+'\n').encode())

    def activate(self, revision):
        before, after = self.candidate(revision)
        if before == after and self.current() == revision: return False
        journal = self.revisions / (revision + '.rollback.json')
        if journal.exists(): raise ValueError('Environment revision has already been attempted')
        active = self.root / 'active-env-revision'
        prior = self.read(active).decode().strip() if active.exists() else None
        self.atomic(journal, json.dumps({'before': before.decode(), 'prior': prior,
                                       'after': hashlib.sha256(after).hexdigest()}).encode())
        # The journal is durable before modifying api.env. The deployment
        # process restores it on failure, including a readiness/health failure.
        self.atomic(self.root / 'activation-pending', (revision + '\n').encode())
        self.atomic(self.root / 'api.env', after)
        self.atomic(active, (revision + '\n').encode())
        return True

    def finish_activation(self, revision, release):
        """Caller must persist the healthy release before releasing this journal."""
        valid_revision(revision)
        record = json.loads(self.read(self.revisions / (revision + '.rollback.json')))
        if (self.activation_pending() != revision or self.active() != revision or
                release.get('env_revision') != revision or
                hashlib.sha256(self.read(self.root / 'api.env')).hexdigest() != record['after']):
            raise ValueError('Environment activation is not committed')
        self.remove_marker('activation-pending')

    def begin_bootstrap(self, sha):
        """Explicit one-time metadata operation; NEVER write the existing api.env."""
        if self.current() is not None or any(self.revisions.iterdir()):
            raise ValueError('Environment already initialized or staged; bootstrap refused')
        before = self.read(self.root / 'api.env')
        revision = 'env-' + secrets.token_hex(16)
        self.atomic(self.root / 'bootstrap-pending', json.dumps({
            'revision': revision, 'sha': sha, 'environmentDigest': hashlib.sha256(before).hexdigest(),
        }).encode())
        return self.resume_bootstrap(sha)

    def resume_bootstrap(self, sha):
        """Only an explicit root recovery can finish a interrupted bootstrap."""
        pending = json.loads(self.read(self.root / 'bootstrap-pending'))
        revision = valid_revision(pending.get('revision'))
        before = self.read(self.root / 'api.env')
        if (pending.get('sha') != sha or pending.get('environmentDigest') != hashlib.sha256(before).hexdigest()
                or self.active() not in [None, revision] or self.pending() or self.activation_pending()):
            raise ValueError('Interrupted bootstrap no longer matches the verified release')
        journal = self.revisions / (revision + '.rollback.json')
        if not journal.exists():
            self.atomic(journal, json.dumps({'before': before.decode(), 'prior': None,
                'after': pending['environmentDigest'], 'bootstrap': True}).encode())
        elif json.loads(self.read(journal)).get('after') != pending['environmentDigest']:
            raise ValueError('Bootstrap journal mismatch')
        self.atomic(self.root / 'active-env-revision', (revision + '\n').encode())
        return revision

    def finish_bootstrap(self, revision, release):
        pending = json.loads(self.read(self.root / 'bootstrap-pending'))
        if (valid_revision(revision) != pending.get('revision') or self.active() != revision
                or release.get('env_revision') != revision or release.get('sha') != pending.get('sha')
                or hashlib.sha256(self.read(self.root / 'api.env')).hexdigest() != pending['environmentDigest']):
            raise ValueError('Bootstrap metadata is not committed')
        self.remove_marker('bootstrap-pending')

    def remove_marker(self, name):
        path = self.root / name
        self.read(path); path.unlink()
        descriptor = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)

    def rollback(self, revision):
        valid_revision(revision)
        record = json.loads(self.read(self.revisions / (revision + '.rollback.json')))
        current = self.read(self.root / 'api.env')
        if hashlib.sha256(current).hexdigest() != record['after']:
            if current != record['before'].encode():
                raise ValueError('Environment changed after activation; refusing stale rollback')
        pending = self.pending()
        if pending not in [None, revision]:
            raise ValueError('Another environment recovery is pending')
        if self.active() not in [revision,record['prior']]:
            raise ValueError('Active environment revision changed; refusing stale rollback')
        activation = self.activation_pending()
        if activation not in [None, revision]:
            raise ValueError('Another environment activation is pending')
        # Keep this durable marker until the previous API has been recreated
        # and both readiness checks succeed, including across process crashes.
        self.atomic(self.root / 'recovery-pending', (revision + '\n').encode())
        if current != record['before'].encode():
            self.atomic(self.root / 'api.env', record['before'].encode())
        active = self.root / 'active-env-revision'
        if record['prior']: self.atomic(active, (record['prior'] + '\n').encode())
        elif active.exists():
            self.read(active); active.unlink()
            descriptor=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(descriptor)
            finally:os.close(descriptor)
        if activation: self.remove_marker('activation-pending')

    def finish_rollback(self, revision):
        valid_revision(revision)
        record = json.loads(self.read(self.revisions / (revision + '.rollback.json')))
        if self.pending() != revision or self.active() != record['prior'] or self.read(self.root / 'api.env') != record['before'].encode():
            raise ValueError('Environment recovery does not match its recorded prior state')
        self.remove_marker('recovery-pending')

    def activation_pending(self):
        marker = self.root / 'activation-pending'
        return valid_revision(self.read(marker).decode().strip()) if marker.exists() else None

    def bootstrap_pending(self):
        marker = self.root / 'bootstrap-pending'
        return valid_revision(json.loads(self.read(marker)).get('revision')) if marker.exists() else None

    def pending(self):
        marker = self.root / 'recovery-pending'
        return valid_revision(self.read(marker).decode().strip()) if marker.exists() else None

    def active(self):
        active = self.root / 'active-env-revision'
        return valid_revision(self.read(active).decode().strip()) if active.exists() else None

    def current(self):
        if self.pending():
            raise ValueError('Environment recovery pending; previous API must be verified by the root recovery')
        if self.activation_pending():
            raise ValueError('Environment activation pending; root recovery required')
        if self.bootstrap_pending():
            raise ValueError('Environment bootstrap pending; explicit root bootstrap recovery required')
        return self.active()
