"""Docker USER names and optional groups; reject every spelling of UID zero."""
import re
def non_root_user(value):
    if not isinstance(value,str) or not value: return False
    user=value.partition(':')[0]
    if re.fullmatch(r'[0-9]+',user): return int(user)>0
    return bool(re.fullmatch(r'[a-z_][a-z0-9_-]*',user,re.I)) and user.lower()!='root'
