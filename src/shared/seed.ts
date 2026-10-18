// 共用字典表的預設內容(SPEC §2.5):測驗庫、動作庫。
// id 固定、時間戳固定,多台裝置各自植入的內容完全相同,同步時不會產生重複或衝突。
//
// ⚠ 常模與切點為文獻參考值,由 AI 依公開文獻整理,尚未經臨床審閱;
//   使用前請治療師逐項核對來源,並可在字典表中自行修改。系統只呈現數字,不做異常判定。
import type { Exercise, TestDef } from './schema';

const T = '2026-01-01T00:00:00.000+08:00';

function test(id: string, code: string, name: string, unit: string, norms: TestDef['norms'], cutoffs: TestDef['cutoffs']): TestDef {
  return { id, code, name, unit, norms, cutoffs, created_at: T, updated_at: T };
}

const STEADI = 'CDC STEADI 30-Second Chair Stand';
const chair = (sex: 'male' | 'female', a: number, b: number, v: number) => ({ sex, age_min: a, age_max: b, value: v, label: '低於此值為低於平均' });

export const SEED_TESTS: TestDef[] = [
  test(
    'test-tug', 'TUG', '起立行走計時(TUG)', '秒',
    {
      source: 'Bohannon 2006 社區長者平均',
      bands: [
        { age_min: 60, age_max: 69, value: 8.1, label: '60–69 歲平均' },
        { age_min: 70, age_max: 79, value: 9.2, label: '70–79 歲平均' },
        { age_min: 80, age_max: 89, value: 11.3, label: '80–89 歲平均' },
      ],
    },
    { value: 12, direction: 'lower_better', label: '文獻切點', source: 'CDC STEADI' },
  ),
  test(
    'test-30scs', '30CST', '30 秒坐站', '次',
    {
      source: STEADI,
      bands: [
        chair('male', 60, 64, 14), chair('male', 65, 69, 12), chair('male', 70, 74, 12), chair('male', 75, 79, 11),
        chair('male', 80, 84, 10), chair('male', 85, 89, 8), chair('male', 90, 94, 7),
        chair('female', 60, 64, 12), chair('female', 65, 69, 11), chair('female', 70, 74, 10), chair('female', 75, 79, 10),
        chair('female', 80, 84, 9), chair('female', 85, 89, 8), chair('female', 90, 94, 4),
      ],
    },
    null,
  ),
  test('test-bbs', 'BBS', '柏格氏平衡量表(BBS)', '分', null, { value: 45, direction: 'higher_better', label: '文獻常用切點', source: 'Berg 1992' }),
  test('test-gait-4m', 'GS4', '步速(4 公尺)', 'm/s', null, { value: 0.8, direction: 'higher_better', label: '文獻切點', source: 'EWGSOP2 2019' }),
  test('test-gait-10m', 'GS10', '步速(10 公尺)', 'm/s', null, { value: 0.8, direction: 'higher_better', label: '文獻切點', source: 'EWGSOP2 2019' }),
  test('test-sppb', 'SPPB', '簡易體能量表(SPPB)', '分', null, { value: 8, direction: 'higher_better', label: '低表現界線(≤8)', source: 'EWGSOP2 2019' }),
  test(
    'test-grip', 'GRIP', '握力', 'kg',
    {
      source: 'AWGS 2019 低肌力切點',
      bands: [
        { sex: 'male', age_min: 0, age_max: 120, value: 28, label: '男性切點(低於為低肌力)' },
        { sex: 'female', age_min: 0, age_max: 120, value: 18, label: '女性切點(低於為低肌力)' },
      ],
    },
    null,
  ),
  test(
    'test-sls', 'SLS', '單腳站(睜眼)', '秒',
    {
      source: 'Springer 2007',
      bands: [
        { age_min: 60, age_max: 69, value: 26.9, label: '60–69 歲平均' },
        { age_min: 70, age_max: 79, value: 15.1, label: '70–79 歲平均' },
        { age_min: 80, age_max: 99, value: 9.4, label: '80 歲以上平均' },
      ],
    },
    null,
  ),
  test('test-mmse', 'MMSE', '簡易智能測驗(MMSE)', '分', null, { value: 24, direction: 'higher_better', label: '常用切點(須依教育程度調整)', source: 'Folstein 1975' }),
];

function ex(id: string, name: string, category: Exercise['category'], region: string | null, sets: number | null, reps: number | null, duration: string | null = null): Exercise {
  return { id, name, category, region, video_ref: null, default_dose: { sets, reps, resistance: null, duration }, created_at: T, updated_at: T };
}

export const SEED_EXERCISES: Exercise[] = [
  ex('ex-mob-joint', '關節鬆動術', 'manual', null, null, null, '5 分鐘'),
  ex('ex-mob-soft', '軟組織放鬆', 'manual', null, null, null, '5 分鐘'),
  ex('ex-stretch', '被動伸展', 'manual', null, null, null, '5 分鐘'),
  ex('ex-sit-stand', '坐站訓練', 'exercise', 'l_knee', 3, 10),
  ex('ex-heel-raise', '提踵', 'exercise', 'l_shank', 3, 12),
  ex('ex-bridge', '橋式', 'exercise', 'lower_back', 3, 10),
  ex('ex-slr', '直膝抬腿', 'exercise', 'l_thigh', 3, 10),
  ex('ex-clam', '蚌殼式', 'exercise', 'l_hip', 3, 12),
  ex('ex-mini-squat', '半蹲', 'exercise', 'l_knee', 3, 10),
  ex('ex-wall-push', '靠牆伏地挺身', 'exercise', 'l_shoulder', 3, 10),
  ex('ex-band-row', '彈力帶划船', 'exercise', 'upper_back', 3, 12),
  ex('ex-balance-tandem', '前後腳站立平衡', 'functional', 'l_ankle', 3, null, '30 秒'),
  ex('ex-sls', '單腳站立', 'functional', 'l_ankle', 3, null, '20 秒'),
  ex('ex-gait', '步態訓練', 'functional', null, null, null, '10 分鐘'),
  ex('ex-transfer', '移位訓練', 'functional', null, 3, 5),
  ex('ex-stairs', '上下階梯訓練', 'functional', null, 3, 5),
  ex('ex-edu-posture', '姿勢與活動調整衛教', 'education', null, null, null),
  ex('ex-edu-fall', '居家環境安全衛教', 'education', null, null, null),
];
