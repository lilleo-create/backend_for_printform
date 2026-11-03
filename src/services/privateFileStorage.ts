import path from 'node:path';

// Keep private media outside the publicly served /uploads directory.
export const privateUploadsRoot = path.resolve(
  process.env.PRIVATE_UPLOADS_DIR || path.join(process.cwd(), 'private-uploads')
);
export const privateChatDir = path.join(privateUploadsRoot, 'chats');
export const privateReturnsDir = path.join(privateUploadsRoot, 'returns');
export const legacyUploadsRoot = path.resolve(process.cwd(), 'uploads');

export const containedFile = (root: string, filename: string): string | null => {
  if (!filename || filename === '.' || filename === '..' || filename.includes('/') || filename.includes('\\') || filename.includes('\0')) return null;
  const full = path.resolve(root, filename);
  const relative = path.relative(root, full);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? full : null;
};
