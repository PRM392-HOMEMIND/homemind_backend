-- Operator applies only after the additive migration. Role is provisioned separately.
grant connect on database homemind to homemind_admin_api;
grant usage on schema public,admin to homemind_admin_api;
grant select(id,email,phone,status,created_at,updated_at,deleted_at,terms_accepted_at,privacy_accepted_at) on public.users to homemind_admin_api;
grant select(id,display_name,phone,address,language) on public.profiles to homemind_admin_api;
grant select(id,name,type,created_at,updated_at,archived_at) on public.workspaces to homemind_admin_api;
grant select(id,workspace_id,user_id,role,created_at) on public.workspace_members to homemind_admin_api;
grant select(workspace_id,plan,product_limit,source) on public.workspace_entitlements to homemind_admin_api;
grant select(id,workspace_id,actor_id,created_at,paid_at,cancelled_at,expires_at,status,financial_state,fulfillment,origin,price_snapshot,amount_paid,review_reason,price_id,order_code,attempts,next_check_at) on public.billing_orders to homemind_admin_api;
grant select(id,workspace_id,order_id,plan,product_limit,starts_at,expires_at,effective_until,superseded_at,superseded_by,created_at) on public.billing_grants to homemind_admin_api;
grant select(channel,reference,order_id,amount,paid_at) on public.billing_transactions to homemind_admin_api;
grant select(id,workspace_id,plan,policy_version,starts_at,expires_at,grant_id,usage_limit,used) on public.assistant_quota_periods to homemind_admin_api;
grant select(id,workspace_id,actor_id,period_id,state,lease_until,created_at,completed_at) on public.assistant_quota_requests to homemind_admin_api;
grant select(id,workspace_id,user_id,kind,status,processing_time_ms,error_code,created_at,expires_at,committed_at) on public.assistant_turns to homemind_admin_api;
grant select(id,workspace_id,name,category,default_unit,status,created_at,updated_at,archived_at) on public.products to homemind_admin_api;
grant select(id,workspace_id,product_id,quantity,quantity_known,unit,expiry_date,created_at) on public.inventory_lots to homemind_admin_api;
grant execute on function public.inventory_quantity_summary(uuid,uuid) to homemind_admin_api;
grant select(id,workspace_id,name,quantity,unit,status,source,linked_product_id,created_by,created_at,updated_at) on public.shopping_items to homemind_admin_api;
grant select(id,recipient_id,workspace_id,kind,financial,target_type,target_id,occurred_at,delivered_at,available_at,attempts) on public.notification_outbox to homemind_admin_api;
grant select(id,recipient_id,workspace_id,kind,financial,target_type,target_id,occurred_at,received_at,read_at) on public.in_app_notifications to homemind_admin_api;
grant select on admin.customers,admin.workspaces,admin.payments to homemind_admin_api;
grant select on admin.principals to homemind_admin_api;
grant select on admin.customer_scope,admin.workspace_scope to homemind_admin_api;
grant select,insert,update on admin.sessions,admin.login_limits to homemind_admin_api;
grant delete on admin.login_limits to homemind_admin_api;
grant select,insert on admin.audit_logs to homemind_admin_api;
-- Only pure tenant predicates, never customer mutation/security-definer commands.
grant execute on function public.current_user_id(),public.is_workspace_member(uuid),public.notification_visible(uuid,uuid,boolean) to homemind_admin_api;

-- Homepage feedback popup (apply after migration 20261009026000_feedback_popup_rewards).
-- Reads are column-limited SELECT like every other admin read model. The ONLY write
-- the inspection role can perform is the audited campaign toggle below; it cannot
-- touch submissions, rewards, grants or any customer data.
grant select on public.feedback_popup_campaigns,public.feedback_popup_config_events to homemind_admin_api;
grant select(id,campaign_id,full_name,email,phone,review,submitter_user_id,submitted_at) on public.feedback_popup_submissions to homemind_admin_api;
grant select(id,submission_id,campaign_id,state,reason,user_id,workspace_id,plan,duration_seconds,anchor_at,bound_at,granted_at,created_at,updated_at,logical_reward_id,allotment_consumed,awarded_at) on public.feedback_popup_rewards to homemind_admin_api;
grant select(reward_id) on public.billing_grants to homemind_admin_api;
grant select on admin.feedback_submissions to homemind_admin_api;
grant execute on function public.feedback_popup_admin_set(boolean,integer,uuid,uuid) to homemind_admin_api;
