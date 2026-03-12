import type { Request, Response, NextFunction } from "express";

export const clientDisconnect = (req: Request, res: Response, next: NextFunction) => {
  res.locals.clientGone = false;

  // close = клиент ушёл / вкладка закрылась / роут сменился
  res.on("close", () => {
    res.locals.clientGone = true;
  });

  // Защита от попыток писать в уже закрытый response
  const _json = res.json.bind(res);
  res.json = ((body: any) => {
    if (res.writableEnded || res.headersSent || res.locals.clientGone) return res;
    return _json(body);
  }) as any;

  const _send = res.send.bind(res);
  res.send = ((body: any) => {
    if (res.writableEnded || res.headersSent || res.locals.clientGone) return res;
    return _send(body);
  }) as any;

  next();
};
