import type { Host } from '@/types';
import * as utils from '@/utils';

describe('utils', () => {
  test('detect IPv4 mapped IPv6 addresses', () => {
    expect(utils.isIPv4MappedIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(utils.isIPv4MappedIPv6('::ffff:7f00:1')).toBe(true);
    expect(utils.isIPv4MappedIPv6('::')).toBe(false);
    expect(utils.isIPv4MappedIPv6('::1')).toBe(false);
    expect(utils.isIPv4MappedIPv6('127.0.0.1')).toBe(false);
    expect(utils.isIPv4MappedIPv6('::ffff:4a7d:2b63')).toBe(true);
    expect(utils.isIPv4MappedIPv6('::ffff:7f00:800')).toBe(true);
    expect(utils.isIPv4MappedIPv6('::ffff:255.255.255.255')).toBe(true);
  });
  test('to and from IPv4 mapped IPv6 addresses', () => {
    expect(utils.toIPv4MappedIPv6('127.0.0.1')).toBe('::ffff:127.0.0.1');
    expect(utils.toIPv4MappedIPv6('0.0.0.0')).toBe('::ffff:0.0.0.0');
    expect(utils.toIPv4MappedIPv6('255.255.255.255')).toBe(
      '::ffff:255.255.255.255',
    );
    expect(utils.toIPv4MappedIPv6('74.125.43.99')).toBe('::ffff:74.125.43.99');
    expect(utils.fromIPv4MappedIPv6('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(utils.fromIPv4MappedIPv6('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(utils.fromIPv4MappedIPv6('::ffff:0.0.0.0')).toBe('0.0.0.0');
    expect(utils.fromIPv4MappedIPv6('::ffff:255.255.255.255')).toBe(
      '255.255.255.255',
    );
    expect(utils.fromIPv4MappedIPv6('::ffff:ffff:ffff')).toBe(
      '255.255.255.255',
    );
    expect(utils.fromIPv4MappedIPv6('::ffff:0:0')).toBe('0.0.0.0');
    expect(utils.fromIPv4MappedIPv6('::ffff:4a7d:2b63')).toBe('74.125.43.99');
    expect(utils.fromIPv4MappedIPv6('::ffff:7f00:800')).toBe('127.0.8.0');
    expect(utils.fromIPv4MappedIPv6('::ffff:800:800')).toBe('8.0.8.0');
    expect(utils.fromIPv4MappedIPv6('::ffff:0:0')).toBe('0.0.0.0');
    // Converting from ::ffff:7f00:1 to ::ffff:127.0.0.1
    expect(
      utils.toIPv4MappedIPv6(utils.fromIPv4MappedIPv6('::ffff:7f00:1')),
    ).toBe('::ffff:127.0.0.1');
  });
  test('resolves zero IP to local IP', () => {
    expect(utils.resolvesZeroIP('0.0.0.0' as Host)).toBe('127.0.0.1');
    expect(utils.resolvesZeroIP('::' as Host)).toBe('::1');
    expect(utils.resolvesZeroIP('::0' as Host)).toBe('::1');
    expect(utils.resolvesZeroIP('::ffff:0.0.0.0' as Host)).toBe(
      '::ffff:127.0.0.1',
    );
    expect(utils.resolvesZeroIP('::ffff:0:0' as Host)).toBe('::ffff:127.0.0.1');
    // Preserves if not a zero IP
    expect(utils.resolvesZeroIP('1.1.1.1' as Host)).toBe('1.1.1.1');
    expect(utils.resolvesZeroIP('::2' as Host)).toBe('::2');
    expect(utils.resolvesZeroIP('::ffff:7f00:1' as Host)).toBe('::ffff:7f00:1');
  });
});
