import { Injectable } from '@nestjs/common';

// ─── Types ───

export interface FinancialStatement {
  stockId: number;
  fiscalYear: number;
  reportType: 'Q1' | 'Q2' | 'Q3' | 'FY';
  revenue: string | null;
  operatingIncome: string | null;
  netIncome: string | null;
  totalAssets: string | null;
  totalLiabilities: string | null;
  totalEquity: string | null;
  sharesOutstanding: number | null;
}

// ─── Constants (1:1 port from us_financial_statement.py) ───

const GAAP_CONCEPTS: Record<string, string[]> = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'SalesRevenueGoodsNet',
    'SalesRevenueServicesNet',
    'RegulatedAndUnregulatedOperatingRevenue',
    'HealthCareOrganizationRevenue',
    'RealEstateRevenueNet',
    'OilAndGasRevenue',
    'InterestAndDividendIncomeOperating',
    'InterestIncomeExpenseAfterProvisionForLoanLoss',
    'BrokerageCommissionsRevenue',
  ],
  operating_income: ['OperatingIncomeLoss'],
  net_income: [
    'NetIncomeLoss',
    'ProfitLoss',
    'IncomeLossAttributableToParent',
    'NetIncomeLossAvailableToCommonStockholdersBasic',
  ],
  total_assets: ['Assets'],
  total_liabilities: ['Liabilities'],
  total_equity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    'MembersEquity',
  ],
};

const SHARES_CONCEPTS: [string, string][] = [
  ['dei', 'EntityCommonStockSharesOutstanding'],
  ['us-gaap', 'CommonStockSharesOutstanding'],
  ['us-gaap', 'SharesOutstanding'],
  ['us-gaap', 'WeightedAverageNumberOfSharesOutstandingBasic'],
];

const FORM_FY = new Set(['10-K', '10-K/A']);
const FORM_Q = new Set(['10-Q', '10-Q/A']);
const REPORT_MAP: Record<string, 'Q1' | 'Q2' | 'Q3'> = {
  Q1: 'Q1',
  Q2: 'Q2',
  Q3: 'Q3',
};

const INSTANT_RE = /^CY\d{4}Q[1-4]I$/;
const SINGLE_Q_RE = /^CY\d{4}Q[1-4]$/;

const BS_FIELDS = new Set(['total_assets', 'total_liabilities', 'total_equity']);
const IS_FIELDS = new Set(['revenue', 'operating_income', 'net_income']);

const MIN_RECENT_YEAR = new Date().getFullYear() - 3;

// ─── Internal helpers ───

type Accounts = Record<string, number>;
type FyData = Map<number, Accounts>;
type QData = Map<string, Accounts>; // key = "fy:fp"

interface XbrlEntry {
  form?: string;
  fy?: number;
  fp?: string;
  val?: number;
  frame?: string;
}

function pickConcept(
  namespace: Record<string, unknown>,
  candidates: string[],
): XbrlEntry[] {
  let best: XbrlEntry[] = [];
  let bestCount = 0;
  for (const concept of candidates) {
    const node = namespace[concept] as Record<string, unknown> | undefined;
    if (!node) continue;
    const units = node.units as Record<string, XbrlEntry[]> | undefined;
    const entries = units?.USD;
    if (!entries) continue;
    const recent = entries.filter((e) => (e.fy ?? 0) >= MIN_RECENT_YEAR).length;
    if (recent > bestCount) {
      best = entries;
      bestCount = recent;
    }
  }
  return best;
}

function placeEntry(
  entry: XbrlEntry,
  field: string,
  fyData: FyData,
  qData: QData,
): void {
  const { form = '', fy, fp, val, frame = '' } = entry;
  if (!fy || val === undefined || val === null) return;
  if (fy > 2100 || fy < 1900) return;

  if (FORM_FY.has(form) && fp === 'FY') {
    if (BS_FIELDS.has(field) && frame && !INSTANT_RE.test(frame)) return;
    const acc = fyData.get(fy) ?? {};
    if (acc[field] === undefined) acc[field] = val;
    fyData.set(fy, acc);
  } else if (FORM_Q.has(form) && fp && fp in REPORT_MAP) {
    if (IS_FIELDS.has(field)) {
      if (frame && !SINGLE_Q_RE.test(frame)) return;
    } else if (BS_FIELDS.has(field)) {
      if (frame && !INSTANT_RE.test(frame)) return;
    }
    const key = `${fy}:${fp}`;
    const acc = qData.get(key) ?? {};
    if (acc[field] === undefined || (frame && SINGLE_Q_RE.test(frame))) {
      acc[field] = val;
    }
    qData.set(key, acc);
  }
}

function extractShares(
  allNs: Record<string, Record<string, unknown>>,
): Map<string, number> {
  const result = new Map<string, number>(); // key = "fp:fy"
  for (const [nsName, conceptName] of SHARES_CONCEPTS) {
    const ns = allNs[nsName] ?? {};
    const node = ns[conceptName] as Record<string, unknown> | undefined;
    if (!node) continue;
    const units = node.units as Record<string, XbrlEntry[]> | undefined;
    if (!units) continue;
    for (const entries of Object.values(units)) {
      for (const e of entries) {
        if (e.fy && e.fp && e.val) {
          const key = `${e.fp}:${e.fy}`;
          if (!result.has(key)) result.set(key, Math.trunc(e.val));
        }
      }
    }
    if (result.size > 0) break;
  }
  return result;
}

function buildStatement(
  stockId: number,
  fiscalYear: number,
  reportType: FinancialStatement['reportType'],
  accounts: Accounts,
  shares: number | undefined,
): FinancialStatement {
  const toStr = (key: string): string | null =>
    accounts[key] !== undefined ? String(accounts[key]) : null;

  return {
    stockId,
    fiscalYear,
    reportType,
    revenue: toStr('revenue'),
    operatingIncome: toStr('operating_income'),
    netIncome: toStr('net_income'),
    totalAssets: toStr('total_assets'),
    totalLiabilities: toStr('total_liabilities'),
    totalEquity: toStr('total_equity'),
    sharesOutstanding: shares ?? null,
  };
}

// ─── Service ───

@Injectable()
export class FactsParserService {
  extractFromFacts(
    stockId: number,
    facts: Record<string, unknown>,
  ): FinancialStatement[] {
    const factsRoot = (facts.facts ?? {}) as Record<string, unknown>;
    const usGaap = (factsRoot['us-gaap'] ?? {}) as Record<string, unknown>;
    const dei = (factsRoot.dei ?? {}) as Record<string, unknown>;
    const allNs: Record<string, Record<string, unknown>> = {
      'us-gaap': usGaap,
      dei,
    };

    const fyData: FyData = new Map();
    const qData: QData = new Map();

    for (const [field, concepts] of Object.entries(GAAP_CONCEPTS)) {
      const entries = pickConcept(usGaap, concepts);
      for (const entry of entries) {
        placeEntry(entry, field, fyData, qData);
      }
    }

    const sharesMap = extractShares(allNs);
    const results: FinancialStatement[] = [];

    const sortedFy = [...fyData.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, 3);
    for (const [fy, accounts] of sortedFy) {
      results.push(
        buildStatement(stockId, fy, 'FY', accounts, sharesMap.get(`FY:${fy}`)),
      );
    }

    const sortedQ = [...qData.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 8);
    for (const [key, accounts] of sortedQ) {
      const [fyStr, fp] = key.split(':');
      const rt = REPORT_MAP[fp];
      if (!rt) continue;
      results.push(
        buildStatement(
          stockId,
          parseInt(fyStr, 10),
          rt,
          accounts,
          sharesMap.get(`${fp}:${fyStr}`),
        ),
      );
    }

    return results;
  }
}
