import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCdekRecipient, resolveCdekSender } from './cdekShipmentContacts';

const seller = () => ({
  name: 'User Name', fullName: 'User Full', phone: '89991234567',
  sellerProfile: {
    contactName: 'Contact Name', contactPhone: '8 (999) 123-45-67',
    representativeName: 'Representative', storeName: 'Store', phone: '89991112233'
  }
});

test('sender uses contact name and phone, normalized to international format', () => {
  assert.deepEqual(resolveCdekSender(seller()), { senderName: 'Contact Name', senderPhone: '+79991234567' });
});

test('sender falls back to representative and profile phone, then user name and phone', () => {
  const value = seller();
  value.sellerProfile.contactName = '';
  value.sellerProfile.contactPhone = '';
  assert.deepEqual(resolveCdekSender(value), { senderName: 'Representative', senderPhone: '+79991112233' });
  value.sellerProfile.representativeName = '';
  value.sellerProfile.phone = '';
  assert.deepEqual(resolveCdekSender(value), { senderName: 'User Full', senderPhone: '+79991234567' });
});

test('missing and invalid sender contacts are rejected without fake defaults', () => {
  const value = seller();
  value.sellerProfile.contactName = '';
  value.sellerProfile.representativeName = '';
  value.name = '';
  value.fullName = '';
  value.sellerProfile.storeName = '';
  assert.throws(() => resolveCdekSender(value), /CDEK_SENDER_NAME_REQUIRED/);
  value.name = 'Seller';
  value.sellerProfile.contactPhone = '';
  value.sellerProfile.phone = '';
  value.phone = '';
  assert.throws(() => resolveCdekSender(value), /CDEK_SENDER_PHONE_REQUIRED/);
  value.phone = '+70000000000';
  assert.throws(() => resolveCdekSender(value), /CDEK_SENDER_PHONE_INVALID/);
});

test('recipient requires a real name and valid phone', () => {
  assert.throws(() => resolveCdekRecipient('', '+79991234567'), /CDEK_RECIPIENT_NAME_REQUIRED/);
  assert.throws(() => resolveCdekRecipient('Buyer', ''), /RECIPIENT_PHONE_REQUIRED/);
  assert.throws(() => resolveCdekRecipient('Buyer', '+70000000000'), /RECIPIENT_PHONE_INVALID/);
  assert.deepEqual(resolveCdekRecipient('Buyer', '89991234567'),
    { recipientName: 'Buyer', recipientPhone: '+79991234567' });
});
