-- AIHUB 中转：OpenAI 兼容的中转站，员工要调工具只能选它转发的 gemini-4-argon / gemini-4-hydrogen
-- （带 -app 后缀的版本不支持工具调用）。接口地址允许自填，默认值在运行时解析里。
INSERT INTO "provider_templates" ("id", "label", "allows_base_url", "probe") VALUES
  ('aihub', 'AIHUB 中转 (OpenAI 兼容)', true, 'chat-completions')
ON CONFLICT ("id") DO NOTHING;
