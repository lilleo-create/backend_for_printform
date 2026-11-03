import type { RequestHandler } from 'express';
import { prisma } from '../lib/prisma';

export const publicUploadGuard: RequestHandler = async (req, res, next) => {
  try {
    // Current public product uploads are single files at the root. Never let
    // the historical chats/returns directories reach the static middleware.
    const raw = decodeURIComponent(req.path);
    if (!/^\/[A-Za-z0-9][^/\\]*$/.test(raw) || raw.includes('..')) {
      return res.status(404).json({ error: { code: 'FILE_NOT_FOUND' } });
    }
    const url = `/uploads${raw}`;
    const privateDocument = await prisma.sellerDocument.findFirst({
      where: { OR: [
        { url: { endsWith: url } },
        { url: { endsWith: encodeURI(url) } },
        { fileName: raw.slice(1) }
      ] }, select: { id: true }
    });
    if (privateDocument) return res.status(404).json({ error: { code: 'FILE_NOT_FOUND' } });
    next();
  } catch (error) {
    if (error instanceof URIError) return res.status(404).json({ error: { code: 'FILE_NOT_FOUND' } });
    next(error);
  }
};
