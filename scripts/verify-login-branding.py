"""CI: decode real assets fully and inspect the compiled login page in Chromium."""
import json
import subprocess
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
out = root / '.generated/login-branding-evidence'
out.mkdir(parents=True, exist_ok=True)
# Loading an <img> or comparing bytes to the source does not prove PNG integrity.
with Image.open(root / 'public/tessera-logo.png') as logo:
    logo.verify()
with Image.open(root / 'public/tessera-logo.png') as logo:
    logo.load()
    assert logo.size == (192, 192)
    assert logo.convert('RGBA').getpixel((96, 144)) == (86, 94, 112, 255)
with Image.open(root / 'public/favicon.ico') as icon:
    assert icon.ico.sizes() == {(16, 16), (32, 32), (48, 48)}
    for size in icon.ico.sizes():
        icon.ico.getimage(size).load()

process = subprocess.Popen(['node', 'scripts/verify-login-logo.mjs', '--serve'], cwd=root, stdout=subprocess.PIPE, text=True)
checks = []
try:
    for line in process.stdout:
        if line.startswith('LOGIN_FIXTURE_READY '):
            origin = line.split(' ', 1)[1].strip().rstrip('/')
            break
    else:
        raise RuntimeError('Compiled login fixture did not start')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        page = browser.new_page()
        external = []
        def route(request):
            if not request.request.url.startswith(origin + '/'):
                external.append(request.request.url)
                request.abort()
            else:
                request.continue_()
        page.route('**/*', route)
        for width, height in [(1440, 1000), (390, 844), (320, 640)]:
            page.set_viewport_size({'width': width, 'height': height})
            assert page.goto(origin + '/login').status == 200
            logo = page.locator('.mark img')
            pixels = logo.evaluate('''async img => {
                await img.decode();
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
                return [...ctx.getImageData(96, 144, 1, 1).data];
            }''')
            assert pixels == [86, 94, 112, 255], pixels
            image_box = logo.bounding_box()
            mark_box = page.locator('.mark').bounding_box()
            assert image_box['width'] == image_box['height'] == 46
            assert image_box == mark_box, (image_box, mark_box)
            icon = page.locator('link[rel="icon"]')
            assert icon.get_attribute('href') == '/favicon.ico?v=21'
            assert icon.get_attribute('sizes') == '16x16 32x32 48x48'
            response = page.request.get(origin + icon.get_attribute('href'))
            assert response.status == 200
            assert response.body() == (root / 'public/favicon.ico').read_bytes()
            page.screenshot(path=str(out / f'login-{width}.png'), full_page=True)
            checks.append({'width': width, 'fullLogoDecoded': True, 'bottomTilePixel': pixels, 'imageBox': image_box, 'faviconStatus': response.status})
        assert not external, external
        browser.close()
    (out / 'result.json').write_text(json.dumps(checks, indent=2))
    print('PASS: complete PNG/ICO decoding; full logo, bottom tile, bounds and public favicon at 1440/390/320px.')
finally:
    process.terminate()
    process.wait(timeout=10)
