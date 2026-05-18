"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sheetsService = void 0;
const googleapis_1 = require("googleapis");
const env_1 = require("../config/env");
const getSheetsClient = () => {
    if (!env_1.env.googleSheetsId || !env_1.env.googleServiceAccountEmail || !env_1.env.googlePrivateKey) {
        return null;
    }
    const auth = new googleapis_1.google.auth.JWT({
        email: env_1.env.googleServiceAccountEmail,
        key: env_1.env.googlePrivateKey.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    return googleapis_1.google.sheets({ version: 'v4', auth });
};
exports.sheetsService = {
    async appendOrderRow(data) {
        const sheets = getSheetsClient();
        if (!sheets || !env_1.env.googleSheetsId) {
            return;
        }
        await sheets.spreadsheets.values.append({
            spreadsheetId: env_1.env.googleSheetsId,
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
