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
  test('detect IPv4 mapped IPv6 Dec addresses', () => {
    expect(utils.isIPv4MappedIPv6Dec('::ffff:127.0.0.1')).toBe(true);
    expect(utils.isIPv4MappedIPv6Dec('::ffff:7f00:1')).toBe(false);
    expect(utils.isIPv4MappedIPv6Dec('::')).toBe(false);
    expect(utils.isIPv4MappedIPv6Dec('::1')).toBe(false);
    expect(utils.isIPv4MappedIPv6Dec('127.0.0.1')).toBe(false);
    expect(utils.isIPv4MappedIPv6Dec('::ffff:4a7d:2b63')).toBe(false);
    expect(utils.isIPv4MappedIPv6Dec('::ffff:7f00:800')).toBe(false);
    expect(utils.isIPv4MappedIPv6Dec('::ffff:255.255.255.255')).toBe(true);
  });
  test('detect IPv4 mapped IPv6 Hex addresses', () => {
    expect(utils.isIPv4MappedIPv6Hex('::ffff:127.0.0.1')).toBe(false);
    expect(utils.isIPv4MappedIPv6Hex('::ffff:7f00:1')).toBe(true);
    expect(utils.isIPv4MappedIPv6Hex('::')).toBe(false);
    expect(utils.isIPv4MappedIPv6Hex('::1')).toBe(false);
    expect(utils.isIPv4MappedIPv6Hex('127.0.0.1')).toBe(false);
    expect(utils.isIPv4MappedIPv6Hex('::ffff:4a7d:2b63')).toBe(true);
    expect(utils.isIPv4MappedIPv6Hex('::ffff:7f00:800')).toBe(true);
    expect(utils.isIPv4MappedIPv6Hex('::ffff:255.255.255.255')).toBe(false);
  });
  test('to IPv4 mapped IPv6 addresses Dec', () => {
    expect(utils.toIPv4MappedIPv6Dec('127.0.0.1')).toBe('::ffff:127.0.0.1');
    expect(utils.toIPv4MappedIPv6Dec('0.0.0.0')).toBe('::ffff:0.0.0.0');
    expect(utils.toIPv4MappedIPv6Dec('255.255.255.255')).toBe(
      '::ffff:255.255.255.255',
    );
    expect(utils.toIPv4MappedIPv6Dec('74.125.43.99')).toBe(
      '::ffff:74.125.43.99',
    );
  });
  test('to IPv4 mapped IPv6 addresses Hex', () => {
    expect(utils.toIPv4MappedIPv6Hex('127.0.0.1')).toBe('::ffff:7f00:1');
    expect(utils.toIPv4MappedIPv6Hex('0.0.0.0')).toBe('::ffff:0:0');
    expect(utils.toIPv4MappedIPv6Hex('255.255.255.255')).toBe(
      '::ffff:ffff:ffff',
    );
    expect(utils.toIPv4MappedIPv6Hex('74.125.43.99')).toBe('::ffff:4a7d:2b63');
  });
  test('from IPv4 mapped IPv6 addresses', () => {
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
      utils.toIPv4MappedIPv6Dec(utils.fromIPv4MappedIPv6('::ffff:7f00:1')),
    ).toBe('::ffff:127.0.0.1');
  });
  test('to canonical IP address', () => {
    // IPv4 -> IPv4
    expect(utils.toCanonicalIp('127.0.0.1')).toBe('127.0.0.1');
    expect(utils.toCanonicalIp('0.0.0.0')).toBe('0.0.0.0');
    expect(utils.toCanonicalIp('255.255.255.255')).toBe('255.255.255.255');
    expect(utils.toCanonicalIp('74.125.43.99')).toBe('74.125.43.99');
    // IPv4 mapped hex -> IPv4
    expect(utils.toCanonicalIp('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(utils.toCanonicalIp('::ffff:0:0')).toBe('0.0.0.0');
    expect(utils.toCanonicalIp('::ffff:ffff:ffff')).toBe('255.255.255.255');
    expect(utils.toCanonicalIp('::ffff:4a7d:2b63')).toBe('74.125.43.99');
    // IPv4 mapped dec -> IPv4
    expect(utils.toCanonicalIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(utils.toCanonicalIp('::ffff:0.0.0.0')).toBe('0.0.0.0');
    expect(utils.toCanonicalIp('::ffff:255.255.255.255')).toBe(
      '255.255.255.255',
    );
    expect(utils.toCanonicalIp('::ffff:74.125.43.99')).toBe('74.125.43.99');
    // IPv6 -> IPv6
    expect(utils.toCanonicalIp('::1234:7f00:1')).toBe('::1234:7f00:1');
    expect(utils.toCanonicalIp('::1234:0:0')).toBe('::1234:0:0');
    expect(utils.toCanonicalIp('::1234:ffff:ffff')).toBe('::1234:ffff:ffff');
    expect(utils.toCanonicalIp('::1234:4a7d:2b63')).toBe('::1234:4a7d:2b63');
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
