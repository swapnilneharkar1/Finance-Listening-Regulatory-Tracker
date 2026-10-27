// Treasury Peer Benchmarking — which NBFCs to benchmark and where their annual reports are.
//
// The collector (treasury.js) finds annual reports automatically, in this order:
//   1. `reports` below — a direct PDF link you add for a specific year (always wins)
//   2. NSE's annual-reports listing for the `nse` symbol
//   3. BSE's standard file name for the `bse` scrip code (bseplus/AnnualReport/<code>/<code>03YY.pdf)
// If a year is missing in the run log (data/treasury/run-log.json), paste that year's PDF link
// into `reports`, e.g.  reports: { FY25: 'https://www.example.com/annual-report-2024-25.pdf' }
//
// To add a peer, copy one block. `base: true` marks the company every peer is compared with.
module.exports = {
  years: 5, // how many financial years to keep (FY21–FY25 when FY25 is the latest)
  companies: [
    { key: 'BFL', name: 'Bajaj Finance', short: 'BFL', base: true, nse: 'BAJFINANCE', bse: '500034', reports: {} },
    { key: 'MAHINDRA', name: 'Mahindra Finance', short: 'Mahindra', nse: 'M&MFIN', bse: '532720', reports: {} },
    { key: 'SHRIRAM', name: 'Shriram Finance', short: 'Shriram', nse: 'SHRIRAMFIN', bse: '511218', reports: {} },
    { key: 'CHOLA', name: 'Cholamandalam Finance', short: 'Chola', nse: 'CHOLAFIN', bse: '511243', reports: {} },
    // Listed on NSE in 2025: older years' annual reports may need a link in `reports`.
    { key: 'HDB', name: 'HDB Financial Services', short: 'HDB', nse: 'HDBFS', reports: {} },
    { key: 'TATACAP', name: 'Tata Capital', short: 'Tata Capital', nse: 'TATACAPITAL', reports: {} },
  ],
};
