DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_owner') THEN CREATE ROLE aesa_owner NOLOGIN CREATEROLE CREATEDB; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_app') THEN CREATE ROLE aesa_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aesa_platform') THEN CREATE ROLE aesa_platform NOLOGIN; END IF;
END $$;
GRANT aesa_app, aesa_platform TO aesa_owner;
ALTER DATABASE aesa_dev OWNER TO aesa_owner;
