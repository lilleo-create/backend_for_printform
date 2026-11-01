import test from 'node:test';
import assert from 'node:assert/strict';
import { persistChatImages, discardChatImages, MAX_CHAT_IMAGE_BYTES } from './chatImages';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const file = (buffer: Buffer, mimetype = 'image/png'): Express.Multer.File => ({
  fieldname: 'files', originalname: 'photo.png', encoding: '7bit', mimetype,
  size: buffer.length, buffer, stream: null as any, destination: '', filename: '', path: ''
});

test('stores one or multiple verified images and returns only server-generated URLs', async () => {
  const saved = await persistChatImages([file(png), file(png)]);
  try {
    assert.equal(saved.attachments.length, 2);
    assert.ok(saved.attachments.every(item => item.url.startsWith('/uploads/chats/')));
    assert.notEqual(saved.attachments[0].url, saved.attachments[1].url);
  } finally { await discardChatImages(saved.paths); }
});

test('rejects invalid image bytes and oversized files before writing', async () => {
  await assert.rejects(persistChatImages([file(Buffer.from('<svg>not png</svg>'))]), /CHAT_IMAGE_TYPE_INVALID/);
  const oversized = file(png);
  oversized.size = MAX_CHAT_IMAGE_BYTES + 1;
  await assert.rejects(persistChatImages([oversized]), /CHAT_IMAGE_TOO_LARGE/);
});
