import { google } from 'googleapis';
import { env } from '../config/env';

const getSheetsClient = () => {
  if (!env.googleSheetsId || !env.googleServiceAccountEmail || !env.googlePrivateKey) {
    return null;
  }

  const auth = new google.auth.JWT({
    email: env.googleServiceAccountEmail,
    key: env.googlePrivateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
};

export const sheetsService = {
  async appendOrderRow(data: {
    orderId: string;
    createdAt: string;
    userEmail: string;
    productTitle: string;
    sku: string;
    variant: string;
    qty: number;
    price: number;
    currency: string;
    status: string;
  }) {
    const sheets = getSheetsClient();
    if (!sheets || !env.googleSheetsId) {
      return;
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: env.googleSheetsId,
      range: 'Orders!A1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [
          [
            data.orderId,
            data.createdAt,
            data.userEmail,
            data.productTitle,
            data.sku,
            data.variant,
            data.qty,
            data.price,
            data.currency,
            data.status
          ]
        ]
      }
    });
  }
};
