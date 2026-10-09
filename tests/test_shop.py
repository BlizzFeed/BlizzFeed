import json
import os

import pytest

from modules.providers import shop

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def load(name):
    """A real family payload, trimmed to the records that hold items and banners."""
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return shop.parse_items(f.read())


@pytest.fixture(scope="module")
def wow():
    return load("shop-wow.rsc")


@pytest.fixture(scope="module")
def overwatch():
    return load("shop-overwatch.rsc")


def stream(*records):
    """A payload like the shop's: `<hex id>:<json>` lines mixed with module references that aren't JSON."""
    lines = ['2:I[9766,[],""]']
    lines += [f"{i + 3:x}:{json.dumps(r)}" for i, r in enumerate(records)]
    return "\n".join(lines) + "\n"


def card(**fields):
    return {"cmsId": None, "productIds": [1], "slug": "thing", "title": "Thing", **fields}


class FakeResponse:
    def __init__(self, content, content_type="text/x-component", status=200):
        self.content, self.status_code, self.url = content, status, "https://shop/x"
        self.headers = {"Content-Type": content_type}

    def raise_for_status(self):
        pass


class FakeSession:
    def __init__(self, response):
        self.response, self.requested = response, []

    def get(self, url, timeout):
        self.requested.append(url)
        return self.response


# --- real payloads ---------------------------------------------------------------------------------------

def test_wow_finds_curated_cards_product_only_items_and_banners(wow):
    kinds = [i["kind"] for i in wow.values()]
    assert kinds.count("item") == 143 and kinds.count("banner") == 5
    assert sum(1 for i in wow.values() if i["kind"] == "item" and i["cmsId"] is None) == 38


def test_an_item_in_several_sections_is_one_entry_listing_them_all(wow):
    free_trial = wow["blt3c75df04a7ee8b14"]
    assert free_trial["sections"] == ["Great for New Players", "Games"]


def test_both_section_shapes_and_an_untitled_one_are_named(overwatch):
    sections = {s for i in overwatch.values() for s in i["sections"]}
    assert {"Seasonal Offers", "Featured", shop.UNTITLED_SECTION} <= sections
    assert all(i["sections"] for i in overwatch.values())


def test_bundles_are_keyed_by_the_link_id_not_by_what_they_contain(overwatch):
    # The link ID is what articles use. productIds list the bundle's contents and can change.
    bundle = next(i for i in overwatch.values() if i["slug"] == "overwatch-shadow-monarch-mega-bundle")
    assert bundle["key"] == f"p:{bundle['itemId']}" == "p:2129813"
    assert bundle["itemId"] not in bundle["productIds"]


def test_a_sale_is_a_discount_amount_and_a_subscription_saving_is_not(wow, overwatch):
    assert any((i.get("price") or {}).get("discountAmount") for i in overwatch.values())
    subscription = next(i for i in wow.values() if i["kind"] == "item" and i["subscriptionIds"])
    assert subscription["price"]["discountPercentage"] and not subscription["price"]["discountAmount"]


def test_a_banner_only_product_is_reached_through_its_banner(wow):
    # WoW Forever is promoted only by the header banner and has no card.
    banners = [i for i in wow.values() if i["kind"] == "banner"]
    assert "world-of-warcraft-forever" in {b["slug"] for b in banners}
    assert not any(i["slug"] == "world-of-warcraft-forever" for i in wow.values() if i["kind"] == "item")


# --- parsing rules ---------------------------------------------------------------------------------------

def test_the_doubled_dollar_sign_of_the_us_shop_is_cleaned():
    payload = stream({"title": "Shop", "cards": [card(price={"fullAmount": "$$29.99", "discountAmount": "$$9.99"})]})
    price = shop.parse_items(payload)["p:1"]["price"]
    assert (price["fullAmount"], price["discountAmount"]) == ("$29.99", "$9.99")


def test_cache_metadata_never_shows_up_as_a_change():
    def payload(age):
        return stream({"title": "Shop", "cards": [card(cacheMetaData={"serverTimeMs": age}, price={"raw": 5})]})
    assert shop.parse_items(payload(1)) == shop.parse_items(payload(2))


def test_lines_that_are_not_json_are_skipped():
    items = shop.parse_items(stream({"title": "Shop", "cards": [card()]}) + ":HC\"https://cdn\"\nbroken:{oops\n")
    assert list(items) == ["p:1"]


def test_key_order_is_cms_id_then_link_id_then_product_ids_then_slug():
    assert shop.item_key(card(cmsId="blt1")) == "blt1"
    assert shop.item_key(card(destination="/family/x/items/77/thing")) == "p:77"
    assert shop.item_key(card(productIds=[3, 4])) == "p:3,4"
    assert shop.item_key(card(productIds=[])) == "s:thing"


# --- fetching --------------------------------------------------------------------------------------------

def test_a_page_that_is_not_the_data_payload_is_an_error():
    session = FakeSession(FakeResponse(b"<html>login</html>", content_type="text/html"))
    with pytest.raises(shop.ShopFetchError):
        shop.fetch_family(session, "https://eu.shop.battle.net/en-gb", "overwatch")


def test_the_body_is_decoded_as_utf8_whatever_the_server_guesses():
    session = FakeSession(FakeResponse("1:{\"t\":\"Warcraft\u00ae\"}".encode("utf-8")))
    assert "Warcraft\u00ae" in shop.fetch_family(session, "https://eu.shop.battle.net/en-gb", "overwatch")


@pytest.mark.parametrize("price,expected", [({"fullAmount": "€9.99", "raw": 9.99}, True), (None, False)])
def test_an_item_page_confirms_a_sale_only_when_it_has_a_price(price, expected):
    body = stream({"title": "Shop", "price": price}).encode("utf-8")
    session = FakeSession(FakeResponse(body))
    item = {"itemId": 77, "slug": "thing"}
    assert shop.item_on_sale(session, "https://eu.shop.battle.net/en-gb", "overwatch", item) is expected
    assert session.requested == ["https://eu.shop.battle.net/en-gb/family/overwatch/items/77"]
