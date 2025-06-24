import { randomBytes } from 'crypto';

export const shortRandomId = (length = 8) => {
  return randomBytes(length).toString('hex').slice(0, length);
};
