import { faAddressCard, faBoxOpen, faBuilding, faCakeCandles, faCalendarDays, faChartLine, faClockRotateLeft, faFileContract, faFileLines, faGear, faHandHoldingDollar, faPalette, faPowerOff, faReceipt, faTableCellsLarge, faTags, faUsers, faUtensils, faCommentDots, faLocationDot, faFilePdf, faWallet } from '@fortawesome/free-solid-svg-icons';

const icons = { profile: faAddressCard, packages: faBoxOpen, building: faBuilding, cake: faCakeCandles, calendar: faCalendarDays, history: faClockRotateLeft, contract: faFileContract, settings: faGear, palette: faPalette, logout: faPowerOff, prices: faTags, users: faUsers, buffet: faUtensils, contact: faCommentDots, location: faLocationDot, pdf: faFilePdf, dashboard: faTableCellsLarge, chart: faChartLine, receive: faHandHoldingDollar, pay: faReceipt, wallet: faWallet, reports: faFileLines };
export type AdminIconName = keyof typeof icons;

export function AdminIcon({ name, size = 16 }: { name: AdminIconName; size?: number }) {
  const [width, height, , , paths] = icons[name].icon;
  return <svg width={size} height={size} viewBox={`0 0 ${width} ${height}`} fill="currentColor" aria-hidden="true" focusable="false">{(Array.isArray(paths) ? paths : [paths]).map((d, i) => <path key={i} d={d} />)}</svg>;
}
