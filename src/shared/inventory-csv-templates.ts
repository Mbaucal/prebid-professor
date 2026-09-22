// Generic starting inventory. Import is always an explicit preview/apply action.
export const sizeMapsTemplateCsv = `name,minWidth,minHeight,sizes
Billboard,0,0,300x250|300x100|300x50
Billboard,360,0,320x100|320x50|300x250
Billboard,768,0,728x90
Billboard,1024,0,970x250|970x90|728x90
Leaderboard,0,0,300x100|300x50
Leaderboard,360,0,320x100|320x50
Leaderboard,768,0,728x90
Leaderboard,1024,0,970x90|728x90
Rectangle,0,0,300x250
Rectangle,768,0,336x280|300x250
P_MAP,0,0,300x250
P_MAP,768,0,300x600|300x250|160x600
InFeed,0,0,300x250
InFeed,768,0,336x280|300x250
InText,0,0,300x250
InText,768,0,336x280|300x250
Sticky,0,0,300x50|300x100
Sticky,360,0,320x50|320x100
Sticky,768,0,728x90
Sticky,1024,0,970x90|728x90
Branding_Left,0,0,
Branding_Left,1366,0,160x600
Branding_Right,0,0,
Branding_Right,1366,0,160x600
TakeOver,0,0,300x250
TakeOver,1024,0,800x600
Native,0,0,fluid`;

const rows: string[] = [];
function add(code: string, type: string, map: string, notes = '') {
  rows.push(`${code},${type},banner,${map},true,${rows.length + 1},${notes}`);
}
for (let i = 1; i <= 7; i++) add(`Billboard_${i}`, i === 1 ? 'ATF' : 'BTF', 'Billboard');
add('Leaderboard', 'ATF', 'Leaderboard');
for (let i = 1; i <= 8; i++) add(`P${i}`, i === 1 ? 'ATF' : 'BTF', 'P_MAP');
for (let i = 1; i <= 6; i++) add(`InFeed_${i}`, 'BTF', 'InFeed');
for (let i = 1; i <= 10; i++) add(`InText_${i}`, 'BTF', 'InText');
add('Sticky', 'ATF', 'Sticky', 'Choose Bottom sticky under Display & loading');
add('Branding_Left', 'ATF', 'Branding_Left', 'Desktop only');
add('Branding_Right', 'ATF', 'Branding_Right', 'Desktop only');
add('TakeOver', 'DRAFT', 'TakeOver', 'Configure TakeOver under Display & loading before activation');

export const adUnitsTemplateCsv = 'code,type,mediaType,sizeMapKey,enabled,sortOrder,notes\n' + rows.join('\n');
