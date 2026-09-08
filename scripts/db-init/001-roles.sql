DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_owner') THEN CREATE ROLE aesa_owner NOLOGIN CREATEROLE CREATEDB; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_app') THEN CREATE ROLE aesa_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_platform') THEN CREATE ROLE aesa_platform NOLOGIN; END IF;
END $$;
-- WITH INHERIT FALSE: aesa_owner can SET ROLE into aesa_app/aesa_platform, but does not automatically
-- inherit their privileges — in particular aesa_platform's `USING true` RLS policy. Without this, a
-- FORCE ROW LEVEL SECURITY table owner would see every row through the inherited platform policy,
-- defeating the "table owner sees nothing" isolation guarantee tenant.test.ts (Task 4) depends on.
GRANT aesa_app, aesa_platform TO aesa_owner WITH INHERIT FALSE;
ALTER DATABASE aesa_dev OWNER TO aesa_owner;
