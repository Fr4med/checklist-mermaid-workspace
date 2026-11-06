-- Keep a project's originating chat separate from its sidebar grouping.
ALTER TABLE projects ADD COLUMN origin_chat_id TEXT;

-- Only chat-scoped records already identify their original chat. Project-wide
-- lists stay unlinked until their verified originating chat is supplied.
UPDATE projects SET origin_chat_id = chat_id WHERE scope = 'chat';
