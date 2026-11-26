# Bidder accounts and supply paths (3.22.1)

An account's **bidder code** is its exact auction identity. **Base adapter** identifies the installed Prebid adapter; **account name** is an internal label. For example, `adf_smn` and `adf_ag` can both use base adapter `adf`, with separate placement parameters and overrides. The build planner requires `adfBidAdapter` once. It must never request an `adf_agBidAdapter` module.

In Demand → Bidders, create or duplicate an account, set its distinct code and partner parameters, and choose its supply path:

| Account SChain | Wrapper behavior |
| --- | --- |
| Use site SChain | Use the saved site chain for this exact account. This is the legacy default. |
| Custom SChain | Use the complete verified account chain instead of the site chain. |
| No upstream SChain (direct publisher path) | Add no site/intermediary chain for this account. The exchange can form its own downstream chain. |

A buyer agency does not become a seller node merely because it owns the demand account. Use the actual seller/payment path. If the wrapper operator is only a technical service on that account, inheriting its intermediary chain would misrepresent that path. Partner account ownership, seller IDs and the exchange's requirements remain factual inputs; the editor does not invent them.

Custom values are retained across mode changes. Invalid custom drafts can be corrected by selecting Custom SChain or explicitly discarded. The normalizer validates version `1.0`, completeness, ordered seller nodes and domain/SID/HP fields. This is structural validation, not proof of seller authorization or SSP receipt.

## Apply and verify

1. Save the account. Saving does not change any published package.
2. Upload a Prebid build containing the original base adapter and required consent/other site modules. Alias registration reuses the same adapter vendor for consent; it does not grant consent.
3. Explicitly select a version that the account form names in Script setup and generate a new TEST package. The form and the Script setup and Generate messages name only versions that apply bidder accounts together with the site's other saved options, and at most two of them: the smallest step (the version with the fewest capabilities, the newest patch on a tie) and the newest version, leaving out versions with a runtime notice. On TEST, the registry ends at 3.24.0. After excluding runtime notices, the offered choice without saved bid caching is **3.22.2 Preview**. With saved bid caching there is **no corrected available combined version**: 3.23.0 and 3.24.0 remain selectable but carry known cache-limit notices. The panels preserve saved options and explain the empty candidate list, without naming unavailable 3.25.x releases or automatically changing the selected runtime. MAIN uses its own release registry and offers corrected cache releases starting at 3.25.1. Older frozen runtime versions remain available; they cannot silently discard an active account alias or custom/none chain.
4. Inspect the exact account in the generated configuration, a native Prebid request and the corresponding adapter HTTP payload. Confirm aliases remain distinct in GAM keys, deals and reporting. An adapter request does not prove downstream SSP acceptance.

This implementation resolves account chains without relying on `firstPartyData.replaceGlobalSchain`, which is unavailable in the earlier tested Prebid builds and does not by itself remove an inherited global chain. Runtime diagnostics must distinguish conflicting external writers from the wrapper's managed account configuration. No publisher setting is upgraded automatically.

## Persistence and imports

Migration `0007_bidder_accounts.sql` adds `bidders.account_json DEFAULT '{}'`. Existing rows retain their exact bidder code, params, overrides and site-chain inheritance. Apply this migration to the relevant MAIN database **before** deploying code that reads the new column. The isolated TEST workspace has a separate explicit reviewed schema-upgrade flow; never initialize over an existing database or erase its saved data.

Full account forms send `expectedUpdatedAt`; stale saves return a conflict instead of restoring an older chain. SQL follow-on writes are conditional on the successful account update. Publisher duplication copies account metadata. Saved releases and frozen compiler sources are immutable.

Bidder CSVs can include `baseAdapter`, `displayName` and `schainJson`. Omitting account columns keeps existing account metadata. Label/base-only imports merge only the supplied fields against the current row, preserving independent concurrent SChain edits. Explicit SChain imports replace only that account's chain setting. The standalone TEST build editor preserves account metadata through read, plan and save.

Deals retain exact account identity. Adform and generic returned-deal paths do not receive an invented universal outgoing Deal ID parameter. PubMatic account aliases use PubMatic's documented outgoing field; exported GAM plans retain the alias-specific keys and creative ad-ID macros.

The isolated TEST workspace exposes the same account choices in **Prebid and bidders**: choose the original bidder adapter, enter an optional distinct account code and account name, then choose the account SChain mode. **Other adapter…** accepts an original adapter code when it is not in the dropdown. The server applies the same account and SChain normalizer used by the main editor. Overrides target the exact account code, including accounts entered in the current unsaved form. Removing or renaming an account keeps an old override visibly unconfigured until the operator chooses its new target; it is never reassigned to another account implicitly. Build preparation preserves these choices before an uploaded Prebid file is activated.
