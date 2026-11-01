import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer, { MulterError } from 'multer';
import type { RequestHandler } from 'express';
import type { ChatImageAttachment } from './activeSupportChatService';

const uploadDir = path.join(process.cwd(), 'uploads', 'chats');
const mimeExtension: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};
export const MAX_CHAT_IMAGES = 5;
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_CHAT_IMAGES, fileSize: MAX_CHAT_IMAGE_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!mimeExtension[file.mimetype]) return callback(new Error('CHAT_IMAGE_TYPE_INVALID'));
    callback(null, true);
  }
}).array('files', MAX_CHAT_IMAGES);

export const chatImageUpload: RequestHandler = (req, res, next) => {
  upload(req, res, (error) => {
    if (!error) return next();
    const code = error instanceof MulterError && error.code === 'LIMIT_FILE_SIZE'
      ? 'CHAT_IMAGE_TOO_LARGE'
      : 'CHAT_IMAGE_UPLOAD_INVALID';
    return res.status(400).json({ error: { code } });
  });
};

const validSignature = (file: Express.Multer.File) => {
  const bytes = file.buffer;
  if (file.mimetype === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimetype === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (file.mimetype === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
};

export const persistChatImages = async (files: Express.Multer.File[]) => {
  if (files.some(file => file.size > MAX_CHAT_IMAGE_BYTES)) {
    const error = new Error('CHAT_IMAGE_TOO_LARGE') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  if (files.length > MAX_CHAT_IMAGES || files.some(file => !mimeExtension[file.mimetype] || !validSignature(file))) {
    const error = new Error('CHAT_IMAGE_TYPE_INVALID') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  const paths: string[] = [];
  const attachments: ChatImageAttachment[] = [];
  try {
    if (files.length) await fs.mkdir(uploadDir, { recursive: true });
    for (const file of files) {
      const filename = `${randomUUID()}${mimeExtension[file.mimetype]}`;
      const absolutePath = path.join(uploadDir, filename);
      await fs.writeFile(absolutePath, file.buffer, { flag: 'wx' });
      paths.push(absolutePath);
      attachments.push({
        type: 'IMAGE',
        url: `/uploads/chats/${filename}`,
        fileName: path.basename(file.originalname).slice(0, 120) || filename,
        mime: file.mimetype,
        size: file.size
      });
    }
    return { attachments, paths };
  } catch (error) {
    await Promise.all(paths.map(file => fs.unlink(file).catch(() => undefined)));
    throw error;
  }
};

export const discardChatImages = async (paths: string[]) => {
  await Promise.all(paths.map(file => fs.unlink(file).catch(() => undefined)));
};
