-- Add photo_public_id column to exhibition_photos table
ALTER TABLE exhibition_photos 
ADD COLUMN photo_public_id VARCHAR(255);

-- Add index for better performance
CREATE INDEX IF NOT EXISTS idx_exhibition_photos_public_id 
ON exhibition_photos(photo_public_id);
