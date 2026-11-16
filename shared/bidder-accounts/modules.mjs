/** The installed module belongs to the adapter, never to an account alias. */
export function adapterModuleForAccount(account) {
  const code = typeof account === 'string' ? account : account?.baseAdapter || account?.bidder;
  if (typeof code !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(code) || ['constructor', 'prototype', '__proto__'].includes(code)) throw new Error('Choose a valid original Prebid adapter code.');
  return `${code}BidAdapter`;
}
