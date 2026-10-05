"""Shared UI actions for the actual saved ad-position editor."""
def add_takeover_position(page, demand='gam'):
    page.locator('#add-map').click()
    page.get_by_label('Map name',exact=True).last.fill('overlay_map')
    page.get_by_label('Map name',exact=True).last.press('Tab')
    page.get_by_label('Allowed sizes',exact=True).last.fill('300x250')
    page.locator('#add-position').click()
    page.get_by_label('Position ID',exact=True).last.fill('Overlay')
    page.get_by_label('Display',exact=True).last.select_option('takeover')
    page.get_by_label('Size map',exact=True).last.select_option('overlay_map')
    page.get_by_label('Demand',exact=True).select_option(demand)
