import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireAuth, type AuthRequest } from '../middleware/authMiddleware';
import { prisma } from '../lib/prisma';
import { containedFile, legacyUploadsRoot, privateChatDir, privateReturnsDir } from '../services/privateFileStorage';

export const privateFileRoutes = Router();
privateFileRoutes.use(requireAuth);

const imageType = async (file: string): Promise<string | null> => {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(12);
    await handle.read(bytes, 0, bytes.length, 0);
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  } finally { await handle.close(); }
};

const sendPrivateImage = async (res: import('express').Response, file: string) => {
  try {
    const mime = await imageType(file);
    if (!mime) return res.status(404).json({ error: { code: 'PRIVATE_FILE_NOT_FOUND' } });
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    return res.sendFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: { code: 'PRIVATE_FILE_NOT_FOUND' } });
    throw error;
  }
};

privateFileRoutes.get('/chats/:filename', async (req: AuthRequest, res, next) => {
  try {
    const filename = req.params.filename;
    const current = containedFile(privateChatDir, filename);
    const legacy = containedFile(path.join(legacyUploadsRoot, 'chats'), filename);
    if (!current || !legacy) return res.status(404).json({ error: { code: 'PRIVATE_FILE_NOT_FOUND' } });
    const attachment = await prisma.chatMessageAttachment.findFirst({
      where: { url: { in: [`/private-files/chats/${filename}`, `/uploads/chats/${filename}`] } },
      select: { url: true, message: { select: { thread: { select: { userId: true, sellerId: true, deletedAt: true } } } } }
    });
    const thread = attachment?.message.thread;
    if (!thread || thread.deletedAt || !(req.user!.isAdmin || req.user!.userId === thread.userId || req.user!.userId === thread.sellerId)) {
      return res.status(404).json({ error: { code: 'PRIVATE_FILE_NOT_FOUND' } });
    }
    return await sendPrivateImage(res, attachment!.url.startsWith('/uploads/') ? legacy : current);
  } catch (error) { next(error); }
});

privateFileRoutes.get('/returns/:ownerId/:filename', async (req: AuthRequest, res, next) => {
  try {
    const { ownerId, filename } = req.params;
    if (!/^[A-Za-z0-9_-]+$/.test(ownerId)) return res.status(404).json({ error: { code: 'PRIVATE_FILE_NOT_FOUND' } });
    const isLegacy = ownerId === 'legacy';
    const root = isLegacy ? path.join(legacyUploadsRoot, 'returns') : path.join(privateReturnsDir, ownerId);
    const file = containedFile(root, filename);
    if (!file) return res.status(404).json({ error: { code: 'PRIVATE_FILE_NOT_FOUND' } });
    const url = isLegacy ? `/uploads/returns/${filename}` : `/private-files/returns/${ownerId}/${filename}`;
    if (isLegacy || req.user!.isAdmin || req.user!.userId !== ownerId) {
      const photo = await prisma.returnPhoto.findFirst({
        where: { url }, select: { returnRequest: { select: { userId: true } } }
      });
      if (!photo || !(req.user!.isAdmin || photo.returnRequest.userId === req.user!.userId)) {
        return res.status(404).json({ error: { code: 'PRIVATE_FILE_NOT_FOUND' } });
      }
    }
    return await sendPrivateImage(res, file);
  } catch (error) { next(error); }
});
