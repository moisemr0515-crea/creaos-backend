const express = require('express');
const request = require('supertest');
const router = require('./subscription.routes');
const controller = require('./subscription.controller');
const service = require('./subscription.service');

describe('callback público de Mercado Pago', () => {
  const app = express().use('/api/v1/subscriptions', router);

  test('funciona sin sesión y redirige a una ruta frontend existente', async () => {
    const res = await request(app).get('/api/v1/subscriptions/mp/callback?status=pending&preapproval_id=fake');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/plan?checkout=return&provider=mercadopago&status=pending');
    expect(res.headers.location).not.toContain('preapproval_id');
  });

  test('un callback manipulado no transporta un plan al frontend', async () => {
    const res = await request(app).get('/api/v1/subscriptions/mp/callback?status=approved&plan=dominator');
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('plan=dominator');
  });

  test('el webhook de MP confirma recepción solo después de procesar la actualización', async () => {
    jest.spyOn(service, 'verifyMercadoPagoSignature').mockReturnValue(true);
    const processWebhook = jest.spyOn(service, 'handleMercadoPagoWebhook').mockResolvedValue({ received: true });
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const next = jest.fn();
    const req = {
      headers: { 'x-signature': 'valid', 'x-request-id': 'request-1' },
      query: { 'data.id': 'preapproval-1' },
      body: { type: 'preapproval', data: { id: 'preapproval-1' } },
    };

    await controller.mercadopagoWebhook(req, res, next);

    expect(processWebhook).toHaveBeenCalledWith(req.body);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ received: true });
    expect(next).not.toHaveBeenCalled();
  });
});
