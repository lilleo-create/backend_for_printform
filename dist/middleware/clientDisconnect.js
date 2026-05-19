"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clientDisconnect = void 0;
const clientDisconnect = (req, res, next) => {
    res.locals.clientGone = false;
    // close = клиент ушёл / вкладка закрылась / роут сменился
    res.on("close", () => {
        res.locals.clientGone = true;
    });
    // Защита от попыток писать в уже закрытый response
    const _json = res.json.bind(res);
    res.json = ((body) => {
        if (res.writableEnded || res.headersSent || res.locals.clientGone)
            return res;
        return _json(body);
    });
    const _send = res.send.bind(res);
    res.send = ((body) => {
        if (res.writableEnded || res.headersSent || res.locals.clientGone)
            return res;
        return _send(body);
    });
    next();
};
exports.clientDisconnect = clientDisconnect;
