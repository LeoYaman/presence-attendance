-- Only a SHA-256 token digest is stored. The opaque token stays in an HttpOnly cookie.
CREATE TABLE attendance.auth_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id uuid NOT NULL REFERENCES attendance.users(id) ON DELETE RESTRICT,
  csrf_token text NOT NULL CHECK (length(csrf_token) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_expiry_idx ON attendance.auth_sessions(expires_at);
CREATE INDEX auth_sessions_user_idx ON attendance.auth_sessions(user_id);
