#!/usr/bin/env python3
"""Claude supported-location snapshot; update against the cited official list.

Source: https://www.anthropic.com/legal/supported-regions
Snapshot checked: 2026-11-18. Country codes are ISO 3166-1 alpha-2.
IP geolocation is not evidence of a user's physical location or eligibility.
"""
import re
import sys

SUPPORTED = frozenset("""AD AE AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BZ CA CD CF CG CH CI CL CM CO CR CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IS IT JM JO JP KE KG KH KI KM KN KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UG US UY UZ VA VC VN VU WS ZA ZM ZW""".split())
# Territories of listed countries, per the policy. Ukraine has excluded
# subregions, which cannot be resolved from an IP country code alone.
SUPPORTED_TERRITORIES = frozenset("""AS GU MP PR UM VI AI BM FK GG GI IM IO JE KY MS PN SH TC VG AX CC CX NF CK NU TK FO GL GF GP MQ RE YT BL MF PM WF PF NC AW BQ CW SX""".split())
PARTIAL = frozenset({'UA'})


def classify(code):
    code = (code or '').strip().upper()
    if not re.fullmatch(r'[A-Z]{2}', code) or code in {'ZZ', 'XX'}:
        return 'unknown'
    if code in PARTIAL:
        return 'unknown'
    return 'supported' if code in SUPPORTED or code in SUPPORTED_TERRITORIES else 'unsupported'


if __name__ == '__main__':
    print(classify(sys.argv[1] if len(sys.argv) > 1 else ''))
