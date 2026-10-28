// Treasury Peer Benchmarking — which NBFCs to benchmark and where their annual reports are.
//
// The collector (treasury.js) finds annual reports automatically, in this order:
//   1. `reports` below — a direct PDF link you add for a specific year (always tried first)
//   2. NSE's annual-reports listing for the `nse` symbol
//   3. the company's own investor pages (`site`), the same pages the FDG document collector uses
//   4. BSE's standard file name for the `bse` scrip code (bseplus/AnnualReport/<code>/<code>03YY.pdf)
// If one copy of a year's report can't be read, the next source is tried.
// If a year is still missing in the run log (data/treasury/run-log.json), paste that year's PDF
// link into `reports`, e.g.  reports: { FY25: 'https://www.example.com/annual-report-2024-25.pdf' }
//
// To add a peer, copy one block. `base: true` marks the company every peer is compared with.
module.exports = {
  years: 5, // how many financial years to keep (e.g. FY22–FY26 when FY26 is the latest)
  companies: [
    { key: 'BFL', name: 'Bajaj Finance', short: 'BFL', base: true, nse: 'BAJFINANCE', bse: '500034', reports: {},
      site: { domains: ['aboutbajajfinserv.com', 'bajajfinserv.in'],
        pages: ['https://www.aboutbajajfinserv.com/finance-investor-relations-annual-reports'],
        exclude: 'housing|bhfl|allianz|life insurance|general insurance|bajaj finserv (?:ltd|limited)|\\bbfsl\\b|bajaj markets|securities|finserv health|\\bamc\\b|asset management|mutual fund|direct ltd|ventures' } },
    { key: 'MAHINDRA', name: 'Mahindra Finance', short: 'Mahindra', nse: 'M&MFIN', bse: '532720', reports: {},
      site: { domains: ['mahindrafinance.com'],
        pages: ['https://www.mahindrafinance.com/investor-relations/financial-information'],
        exclude: 'rural housing|mrhfl|insurance broking|mibl' } },
    { key: 'SHRIRAM', name: 'Shriram Finance', short: 'Shriram', nse: 'SHRIRAMFIN', bse: '511218', reports: {},
      site: { domains: ['shriramfinance.in'], pages: ['https://www.shriramfinance.in/investors/annual-reports'] } },
    { key: 'CHOLA', name: 'Cholamandalam Finance', short: 'Chola', nse: 'CHOLAFIN', bse: '511243', reports: {},
      site: { domains: ['cholamandalam.com'], pages: ['https://www.cholamandalam.com/investors/annual-reports'],
        exclude: '\\bcll\\b|leasing|cholamandalam securities|\\bcsec\\b|home finance|\\bchfl\\b' } },
    // Listed on NSE in 2025: older years come from the company website.
    { key: 'HDB', name: 'HDB Financial Services', short: 'HDB', nse: 'HDBFS', reports: {},
      site: { domains: ['hdbfs.com'], pages: ['https://www.hdbfs.com/investor/dur62-annual-report'] } },
    { key: 'TATACAP', name: 'Tata Capital', short: 'Tata Capital', nse: 'TATACAPITAL', reports: {},
      site: { domains: ['tatacapital.com'], pages: ['https://www.tatacapital.com/about-us/investor-information-and-financials.html'],
        exclude: 'tchfl|housing finance|\\btcfsl\\b|\\btmfl\\b|tata motors finance|tata securities|tata cleantech|\\btccl\\b|moneyfy|wealth' } },
  ],
};
