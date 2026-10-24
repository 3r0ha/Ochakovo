# Эталонные матрицы QR для проверки своего кодировщика shared/qr.ts (scripts/tests/w2-hr-sources-qr.test.ts).
# Сделаны один раз внешними генераторами, результат — cases.json рядом. Перезапускать не нужно.
#
# Главный эталон — библиотека Project Nayuki «QR Code generator» (qrcodegen 1.8.0, PyPI): байтовый режим, уровень M,
# без повышения уровня, версии 1–10. Из неё — выбранная версия и маска (по штрафу ISO/IEC 18004, 7.8.3) и матрица,
# а для части случаев — матрицы со всеми восемью масками (forced): так наложение маски проверяется отдельно от выбора.
# Второй эталон для тех же восьми масок — python-qrcode: другая реализация обязана дать те же модули (pyqrcodeAgrees).
# Для сведения — совпадение с утилитой qrencode (-8 -l M): она выбирает маску по своим правилам штрафа и иногда
# берёт другую (qrencodeAgrees = false). Любая маска читается сканером; сравнение с ней — только для справки.
# segno 1.6.6 как эталон не годится: на границе байта он дописывает лишний нулевой байт вместо 0xEC (данные читаются,
# но это не по стандарту), поэтому его матрицы расходятся с остальными.
#
# Запуск: pip download qrcodegen==1.8.0 --no-deps -d <папка>, распаковать колесо (zip) в <папка>/unpacked, затем
#   QRCODEGEN_DIR=<папка>/unpacked python3 scripts/fixtures/qr/make.py

import json
import os
import subprocess
import sys

sys.path.insert(0, os.environ['QRCODEGEN_DIR'])
from qrcodegen import QrCode, QrSegment  # noqa: E402

import qrcode  # noqa: E402
from qrcode.util import MODE_8BIT_BYTE, QRData  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

TEXTS = [
    'A',
    'fair-misis',
    'https://season.ochakovo.ru/',
    'http://localhost:8848/?src=fair-misis',
    'https://season.ochakovo.ru/?src=fair-misis',
    'https://season.ochakovo.ru/?src=tour-mgupp-vesna',
    'https://season.ochakovo.ru/?src=edu-kolledzh-pishchevoy-promyshlennosti-1',
    'https://t.me/ochakovo_season_bot?start=fair-misis',
    'https://max.ru/ochakovo_season_bot?start=museum-shkolnaya-ekskursiya',
    'https://season.ochakovo.ru/vacancies?src=class-1580&vacancy=bottling-operator',
    'https://season.ochakovo.ru/?src=' + 'a' * 40 + '&utm_source=qr&utm_medium=print&utm_campaign=practice',
    'https://season.ochakovo.ru/vacancies?src=class-1580&vacancy=bottling-operator&from=poster-a3-stend-na-yarmarke',
    'https://season.ochakovo.ru/?' + '&'.join(f'k{i}=v{i}' for i in range(18)),
    'https://season.ochakovo.ru/vacancies?src=edu-mgupp-tekhnologicheskiy-fakultet&vacancy=fermentation-assistant',
    'w' * 100,
    'x' * 150,
    'y' * 180,
    'z' * 213,
]

# Не только ASCII: строка в UTF-8, как её кодирует shared/qr.ts
UTF8 = ['Ярмарка МИСИС', 'https://сезон.очаково.рф/?src=fair-misis']


def nayuki(data: bytes, mask: int = -1):
    q = QrCode.encode_segments([QrSegment.make_bytes(data)], QrCode.Ecc.MEDIUM, 1, 10, mask, False)
    rows = [''.join('1' if q.get_module(x, y) else '0' for x in range(q.get_size())) for y in range(q.get_size())]
    return q.get_version(), q.get_mask(), rows


def pyqrcode(data: bytes, version: int, mask: int):
    q = qrcode.QRCode(version=version, error_correction=qrcode.constants.ERROR_CORRECT_M, border=0, mask_pattern=mask)
    q.add_data(QRData(data, mode=MODE_8BIT_BYTE))
    q.make(fit=False)
    return [''.join('1' if c else '0' for c in row) for row in q.modules]


def qrencode(data: bytes):
    out = subprocess.run(['qrencode', '-8', '-l', 'M', '-m', '0', '-t', 'ASCII'], input=data, capture_output=True, check=True).stdout.decode()
    return [''.join('1' if c == '#' else '0' for c in line[::2]) for line in out.splitlines() if line]


cases = []
for content in TEXTS + UTF8:
    data = content.encode('utf-8')
    version, mask, rows = nayuki(data)
    case = {
        'text': content,
        'version': version,
        'mask': mask,
        'rows': rows,
        'qrencodeAgrees': qrencode(data) == rows,
    }
    if version in (1, 3, 4, 7, 10) or content in UTF8:
        forced = [nayuki(data, m)[2] for m in range(8)]
        case['forced'] = forced
        case['pyqrcodeAgrees'] = all(pyqrcode(data, version, m) == forced[m] for m in range(8))
    cases.append(case)

with open(os.path.join(HERE, 'cases.json'), 'w', encoding='utf-8') as f:
    json.dump({'generator': 'qrcodegen 1.8.0 (Project Nayuki), проверено python-qrcode 8.2', 'cases': cases}, f, ensure_ascii=False, indent=1)

print(
    len(cases), 'случаев; версии:', sorted({c['version'] for c in cases}),
    '; python-qrcode совпал:', sum(1 for c in cases if c.get('pyqrcodeAgrees')), 'из', sum(1 for c in cases if 'forced' in c),
    '; qrencode совпал:', sum(c['qrencodeAgrees'] for c in cases),
)
