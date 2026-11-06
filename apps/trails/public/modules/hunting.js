// A heads-up for anyone on a trail during hunting season. Pure. It's safety advice, not the rules, and
// when the stored dates run out it falls back to a general note rather than guess at new ones.
const HEADS_UP_DAYS = 14;
const MS_PER_DAY = 86400000;
const GENERAL_MONTHS = new Set([8, 9, 10, 11, 0, 3, 4]); // Fall through January, and spring turkey.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = value => String(value).padStart(2, '0');
const localDay = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const shortDate = day => {
  const [, month, date] = day.split('-').map(Number);
  return `${MONTHS[month - 1]} ${date}`;
};
const listText = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

export function huntingNotice(now, firearms) {
  const today = localDay(now);
  const soon = localDay(new Date(now.getTime() + HEADS_UP_DAYS * MS_PER_DAY));
  const open = firearms.filter(({ from, to }) => from <= today && today <= to);
  const coming = firearms.filter(({ from }) => today < from && from <= soon);
  if (open.length || coming.length) {
    const parts = [];
    if (open.length) parts.push(`Firearms deer season is on in ${listText(open.map(({ state, to }) => `${state} through ${shortDate(to)}`))}.`);
    if (coming.length) parts.push(`${open.length ? 'It' : 'Firearms deer season'} starts in ${listText(coming.map(({ state, from }) => `${state} on ${shortDate(from)}`))}.`);
    return `${parts.join(' ')} Sundays included. Wear orange on any trail.`;
  }
  return GENERAL_MONTHS.has(now.getMonth()) ? 'Hunting seasons are open around here. Bright colors or orange are a smart choice on any trail.' : null;
}
