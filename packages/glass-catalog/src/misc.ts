// GENERATED FILE — do not edit by hand.
// Regenerate with: npm run regenerate --workspace @isaac/glass-catalog
//
// Source: Zemax AGF files/MISC.AGF
//
// Materials rather than products — things a lens is made of, or sits in,
// that no maker sells under a catalog name. So this one is *not* a
// manufacturer's own file: it ships with OpticStudio, and each entry cites
// its own literature source instead of a datasheet. Fused silica is
// Malitson's fit by way of the Handbook of Optics, and reproduces the
// printed nd and Vd to nine decimal places.
//
// All 23 entries are here, including glasses no longer made — an old lens
// file is exactly where a discontinued one turns up, so `record.status` says
// which those are rather than the catalog leaving them out.
//
// Dispersion fits: 10 on formula 1 (SCHOTT), 8 on formula 2 (SELLMEIER_1), 5 on formula 5 (CONRADY).
//
// The formula number travels with each glass because it varies per glass, and
// every fit below was checked against the catalog's own printed nd and Abbe
// number before being written here.

import { type GlassRecord, type GlassStatus } from './types.ts';

function g(
  name: string,
  formula: number,
  coefficients: readonly number[],
  minNm: number,
  maxNm: number,
  nd: number,
  abbeNumber: number,
  status: GlassStatus,
): GlassRecord {
  return {
    name,
    manufacturer: 'MISC',
    formula,
    coefficients,
    rangeNm: [minNm, maxNm],
    nd,
    abbeNumber,
    status,
  };
}

/** The 23 glasses of MISC's catalog, as published. */
export const MISC_GLASSES: readonly GlassRecord[] = [
  g(
    'ACRYLIC',
    1,
    [2.16330492, 0.0136580764, 0.0256700975, -0.00280976174, 0.0002842279, -0.00000902124935],
    365,
    1014,
    1.491668,
    55.310192,
    'STANDARD',
  ),
  g(
    'BASF5',
    5,
    [1.57410327, 0.0139786149, 0.00083004511],
    334,
    2325,
    1.603233,
    42.504788,
    'STANDARD',
  ),
  g(
    'BASF55',
    1,
    [2.8080853, -0.013076515, 0.024961324, 0.0019412734, -0.00015776742, 0.000014562956],
    365,
    1060,
    1.69981,
    34.680447,
    'STANDARD',
  ),
  g(
    'CAF2',
    2,
    [0.5675888, 0.00252643, 0.4710914, 0.010078333, 3.8484723, 1200.556],
    230,
    9700,
    1.433849,
    94.995854,
    'STANDARD',
  ),
  g(
    'CDS',
    2,
    [3.9658282, 0.0558036869, 0.18113874, 0.233146066, 0, 0],
    510,
    1400,
    1,
    0,
    'STANDARD',
  ),
  g(
    'COC',
    1,
    [2.28448546, 0.0102952211, 0.0373493703, -0.00928409653, 0.00173289808, -0.000115203047],
    334,
    2325,
    1.533732,
    56.227932,
    'STANDARD',
  ),
  g('CR39', 5, [1.485, 0.009, 0.00055], 500, 850, 1, 0, 'SPECIAL'),
  g(
    'F_SILICA',
    2,
    [0.6961663, 0.004679148, 0.4079426, 0.013512063, 0.8974794, 97.9340025],
    210,
    3710,
    1.458464,
    67.821433,
    'STANDARD',
  ),
  g(
    'KDP',
    2,
    [1.256618, 0.0084478168, 33.89909, 1113.904, 0, 0],
    400,
    1060,
    1.509182,
    56.224997,
    'STANDARD',
  ),
  g('LAF3', 2, [1.5376, 0.00776161, 0, 0, 0, 0], 350, 700, 1.604046, 80.83154, 'STANDARD'),
  g('N15', 5, [1.5, 0, 0], 365, 1014, 1.5, 0, 'STANDARD'),
  g(
    'PMMA',
    1,
    [2.1864582, -0.00024475348, 0.014155787, -0.00044329781, 0.000077664259, -0.0000029936382],
    365,
    1060,
    1.491756,
    57.440791,
    'STANDARD',
  ),
  g(
    'POLYCARB',
    1,
    [2.42838566, -0.0000386116645, 0.0287574474, -0.000197897366, 0.000148358968, 0.00000138651935],
    365,
    1014,
    1.58547,
    29.909185,
    'STANDARD',
  ),
  g(
    'POLYSTYR',
    1,
    [2.44598368, 0.0000221428933, 0.0272988569, 0.000301210852, 0.0000888934888, -0.00000175707929],
    365,
    1014,
    1.590481,
    30.866877,
    'STANDARD',
  ),
  g('PYREX', 5, [1.45217, 0.01258, 0.00006659], 334, 2325, 1.474009, 65.386423, 'STANDARD'),
  g(
    'QUARTZ',
    1,
    [2.35676495, -0.0113996924, 0.0108741656, 0.0000332066914, 0.0000108609346, -3.10123984e-7],
    180,
    710,
    1.544296,
    70.132045,
    'STANDARD',
  ),
  g(
    'SAN',
    1,
    [2.38687023, -0.00123063994, 0.0229467817, 0.000369810122, 0.0000267577106, 0.00000284806182],
    365,
    1014,
    1.56744,
    34.812344,
    'STANDARD',
  ),
  g(
    'SEAWATER',
    1,
    [1.78736713, -0.0165099148, 0.00147685351, 0.00140145252, -0.000162869896, 0.00000841096684],
    334,
    2325,
    1.339529,
    57.917652,
    'STANDARD',
  ),
  g(
    'SILICA',
    2,
    [0.6961663, 0.004679148, 0.4079426, 0.01351206, 0.8974794, 97.934],
    210,
    3710,
    1.458464,
    67.821443,
    'STANDARD',
  ),
  g(
    'TEO2',
    2,
    [2.584, 0.01800964, 1.157, 0.06959044, 0, 0],
    400,
    1000,
    2.274935,
    16.22277,
    'STANDARD',
  ),
  g(
    'TYPEA',
    5,
    [1.49224183, 0.0101876827, 0.000856657692],
    334,
    2325,
    1.51509,
    41.585023,
    'STANDARD',
  ),
  g(
    'VACUUM',
    2,
    [-0.00009983407, -0.00531510156, -0.0031144725, 0.0103934642, 0.00267863389, 0.0107652513],
    334,
    2325,
    0.999728,
    89.195538,
    'STANDARD',
  ),
  g(
    'WATER',
    1,
    [1.75972105, -0.0112081602, 0.00793533773, -0.000413306965, 0.0000805068807, -0.00000454289876],
    400,
    700,
    1.333044,
    55.794322,
    'STANDARD',
  ),
];
