-- Test (rehearsal) projects are marked by policies.test, no longer by Telegram being off: a real project with Telegram off must still
-- show in reports, the work log, certification and the group chat. Projects that were test projects by the old rule keep that status.
UPDATE workspaces SET policies = json_set(CASE WHEN json_valid(policies) THEN policies ELSE '{}' END, '$.test', json('true'))
  WHERE json_valid(policies) AND json_extract(policies, '$.telegram') = 0 AND COALESCE(json_extract(policies, '$.test'), 0) = 0;
