jest.mock('./business.service', () => ({
  subirFotos: jest.fn(),
}));
jest.mock('./businessAssetAccess.service', () => ({}));

const businessService = require('./business.service');
const { uploadPhotos } = require('./business.controller');

const response = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('business.controller — contrato multipart de fotos', () => {
  beforeEach(() => jest.clearAllMocks());

  test('pasa archivos nuevos e índices retenidos al service tenant-safe', async () => {
    const negocio = { _id: 'business-a', photos: ['a', 'b'] };
    businessService.subirFotos.mockResolvedValue(negocio);
    const req = {
      businessId: 'business-a',
      files: [{ originalname: 'nueva.jpg' }],
      body: { retainPhotoIndexes: '[1]' },
    };
    const res = response();
    const next = jest.fn();

    await uploadPhotos(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(businessService.subirFotos).toHaveBeenCalledWith(
      'business-a',
      req.files,
      [1],
    );
    expect(res.json).toHaveBeenCalled();
  });

  test('rechaza índices duplicados o fuera del máximo de dos fotos', async () => {
    const req = {
      businessId: 'business-a',
      files: [{ originalname: 'nueva.jpg' }],
      body: { retainPhotoIndexes: '[1,1]' },
    };
    const next = jest.fn();

    await uploadPhotos(req, response(), next);

    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(businessService.subirFotos).not.toHaveBeenCalled();
  });
});
