-- Adds parent_comment_id column to comments table if it does not already exist.
ALTER TABLE IF EXISTS comments
ADD COLUMN IF NOT EXISTS parent_comment_id UUID REFERENCES comments(id);
