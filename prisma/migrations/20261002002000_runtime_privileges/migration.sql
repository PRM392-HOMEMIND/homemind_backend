alter default privileges for role homemind_migrator in schema public revoke execute on functions from public;
alter default privileges for role homemind_migrator in schema public revoke all on tables from public;
alter policy members_own on public.workspace_members
 using(user_id=public.current_user_id() and public.is_workspace_member(workspace_id));
