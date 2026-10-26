import struct
import unittest
import numpy as np
from scripts.prepare_spz_sh8 import quantize_sh, replace_sh


class SpzSh8Test(unittest.TestCase):
    def test_ties_and_saturation(self):
        values = np.array([-2, -1, -.5 / 128, .5 / 128, 1, 2], dtype='f4')
        np.testing.assert_array_equal(quantize_sh(values, 8), [0, 0, 127, 129, 255, 255])

    def sample(self):
        sh = np.linspace(-.4, .4, 90, dtype='f4').reshape(2, 45)
        prefix = struct.pack('<IIIBBBB', 0x5053474e, 3, 2, 3, 12, 1, 0) + bytes(range(40))
        return prefix + quantize_sh(sh, [5] * 9 + [4] * 36).tobytes(), sh

    def test_only_sh_changes(self):
        raw, sh = self.sample()
        changed, offset = replace_sh(raw, sh)
        self.assertEqual(offset, 56)
        self.assertEqual(raw[:offset], changed[:offset])
        self.assertEqual(len(raw), len(changed))
        self.assertNotEqual(raw[offset:], changed[offset:])
        decoded = (np.frombuffer(changed[offset:], dtype='u1').astype('f4') - 128) / 128
        self.assertLessEqual(float(np.max(np.abs(decoded - sh.ravel()))), 1 / 256)

    def test_rejects_unmatched_control_and_unsupported_layout(self):
        raw, sh = self.sample()
        for invalid in [raw[:-1], raw[:8], raw[:14] + bytes([129]) + raw[15:], raw[:-1] + bytes([raw[-1] ^ 1])]:
            with self.assertRaises(ValueError):
                replace_sh(invalid, sh)
        with self.assertRaises(ValueError):
            replace_sh(raw, sh[:1])


if __name__ == '__main__':
    unittest.main()
