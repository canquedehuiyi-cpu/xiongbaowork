# Arcade

Arcade is a broker, the same kind of thing Composio is: it holds people's accounts at other apps —
Gmail, Google Calendar, GitHub, Asana and more — and publishes each app's actions as tools this
deployment can call on somebody's behalf. A Bot with a brokered action granted reaches the app **as
the person asking**, so two people asking the same question get the answers their own accounts can
see. Where Arcade differs from Composio is the part an operator has to set up: **an Arcade project
needs an OAuth app of your own for every provider, and one manual step in Arcade's dashboard.** This
page is about those, and about what to tell somebody when a connection looks wrong.

Read [Composio](composio.md) first if you have not: what a broker is, what Personal and Shared mean,
the approval rules and the audit trail are the same here and are not repeated.

**This page is this fork's.** It is upstream OpenBot's `docs/plugins/arcade.md`, checked paragraph by
paragraph against the code here. Where this fork behaves differently the paragraph says what the fork
does and is marked **与上游不同** (differs from upstream); [a section near the end](#与上游不同-the-whole-list)
lists every one. The setup checklist's link for this row still opens upstream's copy of this page,
which describes several things this fork does not do, so read this one.

Some things on this page are stated as **unproven**, and a section near the end lists them. What is
marked _measured_ was observed **by upstream**, by hand, against a live Arcade project, in two rounds
(2026-10-12 with a throwaway script, and once on 2026-10-13 with the live suite). **This fork has
not repeated any of it.** The adapter here (`server/src/plugins/arcade-adapter.ts`) is upstream's
file with the sentences a person reads translated, so the measurements are about the same code; the
live suite is in the tree (`server/tests/arcade-live.test.ts`, `ARCADE_API_KEY=… bun run
test:live-arcade`, which needs a person at a browser to consent), and without a key every case in it
skips, which is what CI does. **Nothing in CI dials Arcade** — the vendor's behavior can change
without any check here noticing.

## Who sets what, and where

Setting it up takes three hands, and none of them can do another's:

| Who              | Does                                                         | Where                                                                            |
| ---------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Whoever deploys  | Sets `ARCADE_API_KEY`                                        | The deployment's environment. There is no screen for it                          |
| Whoever deploys  | Sets `OPENBOT_BROKER_PROVIDER`, only where both keys are set | The deployment's environment                                                     |
| Whoever deploys  | Registers an OAuth app per provider, and sets the verifier   | Arcade's dashboard, below                                                        |
| An administrator | Enables an app and grants its actions to a Bot               | `/admin/plugins/composio`, then the app's own page, `/admin/plugins/arcade-<Toolkit>` |
| Each person      | Connects their own account to that app                       | `/settings/connected-accounts`                                                   |

The key is an environment variable and nothing else, as Composio's is. No administrator can turn
Arcade on from a page. The Helm chart has a value for Composio's key (`secrets.composioApiKey`) and
none for Arcade's.

**与上游不同.** Upstream has a directory page of its own for Arcade (`/admin/plugins/arcade`) and
people connect on `/connections`. This fork has one directory page, `/admin/plugins/composio`
(浏览应用), which lists whichever broker is active, Arcade's toolkits included, and people connect
under 已连接账号, `/settings/connected-accounts`. An enabled Arcade app is the row
`arcade-<Toolkit>` at `arcade://<Toolkit>`, with the toolkit's capitals kept: Arcade's names are
case-sensitive.

**A single-user deployment can use Arcade too**, the personal edition included
(`OPENBOT_SINGLE_USER=true`). Each such install is filed at Arcade under its own name, not under
`dev-local-user`, so several of them on one `ARCADE_API_KEY` do not use each other's consents; see
[Configuration](../configuration.md). It also owns its Arcade project and points the verifier at
itself; see [The verifier URL](#the-verifier-url).

### Choosing the provider

A deployment runs one broker at a time. `OPENBOT_BROKER_PROVIDER` takes `composio` or `arcade`, and
anything else stops the server at startup.

**Where exactly one of the two keys is set and the variable is unset, that provider is the active
one, so no existing deployment has to set anything.** The variable matters only when both keys are
set. Setting both is legal and expected, because ending an account at the old vendor needs that
vendor's key. With both set, the variable has to say which one is live: both set and the variable
unset stops the server at startup rather than coming up with no broker at all. A key that is empty
or all whitespace — `ARCADE_API_KEY=` with nothing after it — is no key.

**`scripts/start.sh` and `bun run setup:composio` leave an Arcade deployment alone.** The helper
provisions a Composio project only where Composio is what the deployment would use: it skips where
`OPENBOT_BROKER_PROVIDER=arcade` is set, or `ARCADE_API_KEY` is set with no provider named, so
starting an Arcade deployment that way does not add a Composio key beside Arcade's.

**Connections already made are still read as their own provider's while nothing is active.** A
deployment whose broker key has been withdrawn afterwards names the provider it reads from the rows
it actually holds (people's rows in `composio_connections`, and Shared apps whose team account is
connected), so an Arcade deployment does not have its Arcade connections read as Composio ones,
shown as absent, and left unrevokable. No broker is live in that state, so nothing can be connected
or revoked until a key is set again; the server says so once at startup. Holding rows at BOTH
vendors with nothing active is refused rather than guessed at, which is the activation refusal from
the other side. (Both keys set with the variable unset does not reach this: that state is refused at
startup, below.)

Connections are kept where Composio's are: a person's in `composio_connections`, whose `provider`
column says which broker made the row, and a Shared app's team account on the app's own
`mcp_servers` row. (Upstream keeps both in `brokered_connections`.)

Four refusals protect the choice, and all are deliberate. The sentences are this fork's, in
Chinese, and name variables, never values:

- **A named provider whose key is not set stops the server at startup.** An operator sees:
  _OPENBOT_BROKER_PROVIDER=arcade 指明的提供商没有配置 ARCADE_API_KEY。请把 ARCADE_API_KEY 设为这个部署的
  key，或者修改、去掉 OPENBOT_BROKER_PROVIDER。_ It does not fall back to a deployment with no
  broker, because that would send somebody looking for a broken vendor instead of at their own
  environment.
- **Both keys set with the variable unset stops the server at startup.** The message names both
  keys and says to set `OPENBOT_BROKER_PROVIDER` to `composio` or `arcade`. Nobody wants that state
  on purpose — the deployment would hold two vendor keys and broker nothing — and wiring no broker
  silently would surface much later and far away, as brokered features that simply do not work.
- **Activating a provider is refused while the other one still holds connections.** It is keyed on
  connection rows, not on keys: people's rows in `composio_connections` under the other provider,
  plus Shared apps of the other provider whose team account is connected. The message names the
  provider being activated and how many connections still belong to the other. Switching by editing
  the environment would leave accounts nobody can revoke. **There is no one-step migration**; what
  ends the old provider's connections is keeping it active (both keys set,
  `OPENBOT_BROKER_PROVIDER` naming the old provider) and using the ordinary ways a connection ends,
  each of which revokes at the vendor and deletes the row: each person disconnects their own under
  已连接账号, an administrator disconnects a Shared app's team account, or an administrator removes
  an app (which ends every account connected to it). When the old provider holds no connections,
  name the new one and restart.
- **Holding connections at BOTH providers while nothing is active stops the server at startup.** It
  is the refusal above seen from the other side: with no provider named there is nothing to read one
  vendor's rows as, and reading them as the other's is the failure this section exists to prevent.
  The message names both vendors and says plainly that nothing in the deployment can get past this:
  with rows at both, activating either provider is refused by the rule above. The only way out is by
  hand: end one vendor's accounts in that vendor's own dashboard, delete its connection rows, then
  name the other provider. The refusal at activation exists so that this state is never reached.

## Setting up the Arcade project

### One Arcade project per deployment

Create one Arcade project for each deployment. The verifier URL (below) is a setting of the
**project**, one address for the whole project, and this fork never changes it: a second deployment
on the same project would have its consents sent to the first one's address.

### An OAuth app of your own, per provider

**Arcade's preconfigured providers cannot be used.** Register your own OAuth app at each provider
(Google, GitHub, and so on) and give its client id and secret to Arcade as that provider's
configuration.

Upstream confirmed this the hard way, and the reason matters because it is not a preference. A
consent link was minted for an arbitrary `user_id` against Arcade's default Google provider. It
**failed at verification** with _"the authorization process was not completed"_. The same consent
minted for an Arcade project member's own identity **completed**. Arcade's built-in verifier has to
recognize the end user as a member of the project, so it can only serve a `user_id` that is one.
Per-person connections in OpenBot are arbitrary ids by definition — nobody is made a member of your
Arcade project in order to connect their mailbox — so a default provider cannot serve them at all.

Arcade's admin API can create the OAuth provider, so that part can be scripted. This fork's
"deployment's own OAuth client" screen is Composio's alone: on an Arcade deployment
`PUT /api/plugins/composio/clients/:slug` answers 409 and says the client is configured in Arcade's
dashboard.

> **Decide about the agentic-client checkbox deliberately — unproven.** Google's console offers
> _"Use this client for an AI-powered agent"_ on an OAuth client. It is a self-declaration, and
> ticking it puts that client under a separate administrative-policy surface; Google's own advice is
> to register separate client ids for human workflows and agent workflows. Every brokered call
> OpenBot makes is agent-initiated, so this is a choice a deployer should make on purpose rather
> than leave at its default. **It was not exercised:** the client upstream used for the measurements
> on this page was registered with the box left unticked, deliberately, to keep a policy variable
> out of the measurement. What ticking it changes in practice is therefore not known here.

### The verifier URL

**After somebody finishes an app's consent, Arcade sends their browser to the project's custom user
verifier, and that has to be this deployment's verify route:**

```
<this deployment's public origin>/api/plugins/arcade/verify
```

The origin is this API's public origin, `OPENBOT_PUBLIC_URL`, which defaults to `BETTER_AUTH_URL`.
It is the API's origin, not the browser app's, where the two differ. A browser that arrives there is
sent on to the app's page under 已连接账号, or to the list with a reason beside it if the consent
was refused.

Before every Connect, the deployment reads the project's setting through Arcade's admin API
(`GET /v1/admin/settings/session_verification`, in [Arcade's OpenAPI](https://api.arcade.dev/v1/swagger)).
Where it already names this deployment's verify route, with verification not skipped, the consent
goes ahead. Arcade has one verifier per project and refuses a per-request return address
(`next_uri`) on a mint, so this setting is the only way a consent finds its way back. What happens
when it names somewhere else depends on whether the install owns its Arcade project.

**A single-user install owns its project and sets the verifier itself.** It has its own name at
Arcade (see [Configuration](../configuration.md)), its one person is its admin, and the personal
edition is one of these. Where the setting names another address, or is set to skip verification,
it sets it to its own verify address with the custom verifier on (`PUT` on the same path), reads it
back, and only then mints the consent. It logs `arcade-verifier-pointed` with the address it
replaced. Nothing needs pasting into Arcade's dashboard, and the install is not tied to
`localhost:3001` or any other address somebody once typed there. If Arcade refuses the write, or
reads back something else, Connect is refused before anybody is sent to a consent screen, and the
log has an `arcade-verifier-not-pointed` line with the address to set by hand. Single-user installs
sharing a project (several on one key) take turns: whichever started the latest consent is where
Arcade sends people back, so a consent started in one while another's is still open comes back to
the later one, which refuses it, and the person presses Connect again.

**A deployment that signs people in treats its project as shared and never changes it.** Rewriting
the setting there would send another deployment's people here. Set the custom verifier
in Arcade's dashboard (Auth, Settings) to this deployment's verify address. The server prints which
address at startup, as a warning, and until the project names it, Connect is refused before anybody
is sent to a consent screen. The log has an `arcade-verifier-elsewhere` line naming the address it
wanted and the one it found.

**与上游不同.** Where upstream shows the person _"Arcade would send you back somewhere else… Ask an
admin to set the custom verifier in Arcade's dashboard to `<address>`"_ (or, on a single-user
install, _"OpenBot couldn't set Arcade to send you back here…"_), this fork does not name the broker
to a member: the person sees _没能开始连接 Gmail。请稍后再试；如果一直这样，请联系管理员。_ and
the address is in the startup warning and the log line.

**A setting that cannot be read refuses the Connect too**, on either kind of deployment, with an
`arcade-verifier-unread` line in the log. The key has to be a project key that can use Arcade's admin API, which every other admin
call here (auth providers, user connections) already needs. A consent minted without the check could
be spent on a page that does not exist.

**A deployment that does not know its own origin cannot check the setting.** With neither
`OPENBOT_PUBLIC_URL` nor `BETTER_AUTH_URL` set, it logs a warning at startup naming the variables to
set, and consents come back to whatever address the project names.

**If the project were left at Arcade's built-in verifier, this deployment's verify route would never
be called.** That route is the return leg that binds a consent to the attempt that started it, checks
that the identity returning is the one the attempt was minted for, records the connection and files
its `mcp.account_connected` audit entry. What upstream observed by hand (see the top of this page) is
that Arcade's built-in verifier refuses a consent for any `user_id` that is not a member of the
Arcade project, and the ids this deployment sends are its own internal ids, not project members, so
in practice nobody could connect. That is why a single-user install turns the custom verifier on
rather than only setting the address.

### What the return leg does, in order

A connection is recorded here and nowhere else, and every step is bound to the person who pressed
Connect:

1. Connect claims an attempt in that person's name **before** asking Arcade for a consent link, and
   writes Arcade's authorization id onto it. **One person has one attempt in progress at a time**
   (a second Connect answers 409), it lapses after 15 minutes, and
   `DELETE /api/plugins/servers/:id/authorize` cancels it. An attempt with no authorization id on it
   can never complete.
2. The browser comes back to `/api/plugins/arcade/verify?flow_id=…`. With no session it is sent to
   sign in and brought back; a session that is recognised and refused answers 403 and records
   nothing.
3. The route finds **that person's own** attempt. One they cancelled answers `cancelled`; one they
   may no longer record — the app changed account mode, the team identity changed, the person
   connecting a team account is no longer an administrator — answers `not-permitted`.
4. Only then is Arcade asked to confirm the return for the attempt's account, and the confirmed
   authorization id has to be the one on the attempt, the authorization completed, and completed by
   that account. Anything else records nothing.
5. The connection and its audit entry are written in one transaction that succeeds once.

**与上游不同: cancelled and no-longer-permitted are judged before Arcade is asked to confirm.**
With a custom verifier it is the confirmation that makes a consent take effect at Arcade, so in
those two cases the consent never takes effect and nothing is left behind there. Upstream confirms
first and then decides.

**与上游不同: what happens to a grant that was left behind.** One way remains: the attempt is
cancelled while its return is being processed, after Arcade has confirmed. Then:

- **A Shared app's team account is revoked at Arcade.** The team identity is minted at random for
  each app and each switch to Shared, so revoking it cannot take another app with it. Only Arcade
  answering that it revoked counts; if it finds nothing or fails, the grant is recorded in the audit
  trail instead, as below.
- **A person's own account is only recorded**: an `mcp.cancelled_grant_left_live` audit entry, and
  the person is told (`cancelled-left-live`). It is their own grant under their own id, and
  revoking it would end their other apps on the same auth provider (see
  [Disconnecting one app may end another](#disconnecting-one-app-may-end-another)).

A refused return lands on `/settings/connected-accounts?authorized=<reason>`. The reasons this fork
answers are `no-broker`, `missing-handle`, `no-attempt`, `cancelled`, `not-permitted`,
`vendor-unavailable`, `not-your-authorization`, `authorization-failed`, `not-finished`,
`cancelled-left-live` and `not-recorded`. **The page does not yet turn the word into a sentence**:
read it off the address. Neither the consent link nor anything Arcade answered is ever put in a
response, a log line or the audit trail; the link is a bearer credential and a status answer carries
an access token.

## What an administrator does

The shape is Composio's: enable an app, grant its actions to a Bot, and each person connects their
own account (or an administrator connects a Shared app's team account, which goes through the same
consent and return leg under the deployment's identity, and still needs shared use approved for each
Bot before a call goes out on it). Two things are different and worth reading before pressing
**Add**.

### Connect asks for the whole app

**Connect works as it does on Composio.** It asks Arcade for one consent covering every scope the
app's actions publish (the `auth.authorize` call, with the app's own authorization requirement read
off its listing), and the consent comes back through the verifier above, which records the
connection and lands the person on the app's page under 已连接账号. That is where it lands
whichever page Connect was pressed on. Actions name the same requirement when they name the same
auth provider instance, its `id` (or the same `provider_id` where none names an `id`): the live
catalogue publishes one instance with and without its `provider_id` (`SquareupApi`) and two
instances with neither (`XeroApi`).

The connection is a row in this deployment's `composio_connections`, as Composio's are: a Bot's call
needs that row before it reaches Arcade, a page that opens the app asks Arcade whether the
connection is still there and clears the row when it is not, and Disconnect ends it at Arcade and
then here. Arcade still checks each action itself on every call.

**与上游不同: approving one action at a time is not merged.** Upstream's action list under
Connections authorizes a single action, for somebody who wants to grant less than the whole app.
This fork has neither that route nor the list of what an account has authorized; Connect is the only
consent, and it asks for the whole app. Two consequences:

- An app whose actions name more than one auth provider instance **cannot be connected here at
  all.** Connect refuses it, and the sentence it shows still tells the person to authorize actions
  one at a time, which this fork has no screen for.
- Narrowing what a Bot may do is done with the tool grant alone; see
  [Scope versus tool grant](#scope-versus-tool-grant).

**与上游不同: a grant Arcade already holds is not adopted.** Upstream records the connection
without a consent screen when Arcade already holds everything the app asks for, and records one for
a grant with no row when the person opens the app. This fork records a new Arcade connection only
through the return leg above. So **where Arcade holds a grant and this deployment has no row for
it**, Connect answers an error — _你的账号已经允许 Gmail 需要的全部权限，所以没有打开授权页面。_ —
and opening the app's page writes nothing. Known limit: the way out is to revoke that grant in
Arcade's dashboard (the user's connection for that auth provider), then press Connect again.
Revoking there ends the person's other apps on the same auth provider too.

**A person can hold a second account at an app.** Arcade keeps one account per user id and auth
provider, so a person's second account at an app (**Connect another account**,
`POST /servers/:id/connect?another=1`) is filed there under a further id of theirs,
`<their id>~<suffix>`, with a random suffix minted by the server when they press it. The return leg
is the same one: only the session that pressed it can finish it. The connection row stays under the
person's own id and the further account is recorded beside it in `brokered_accounts`; the app's page
lists both by the address the provider reported. A Bot's call that names one of them runs in that
account, a call that names none runs in the person's default one, and a name the person does not
hold is refused before Arcade is asked. Disconnecting one account withdraws that one; disconnecting
the app, offboarding the person or removing the app withdraws every account they hold there. A
Shared app has one team account and no second one.

**与上游不同: no Reconnect card, and no Reconnect button.** When Arcade refuses a call for want of
authorization, the call fails and the Bot is told the action is not allowed on this account; the
row is not cleared and no card is drawn. Connect on an app that already has a row answers 409, so
connecting again is Disconnect and then Connect.

### Toolkits are curated or they are wrappers, and the difference was measured

Every action carries a classification — whether it reads or writes, whether it is destructive — and
what OpenBot asks before running it depends on that classification. Arcade publishes it as
`metadata.behavior` on each tool, and toolkits fall into two groups (_measured_ by upstream):

| Toolkit     | Tools              | With `metadata.behavior` |
| ----------- | ------------------ | -----------------------: |
| `Github`    | 43                 |                       43 |
| `Asana`     | 19                 |                       19 |
| `GithubApi` | 100 (the page cap) |                    **0** |

Curated toolkits classify every tool. Generated API wrappers classify none. An action that is not
classified is recorded as an **unclassified write** (`unclassified` on `mcp_tools`), because an
unlabelled action is not claiming to be safe. It asks first wherever a change asks, and no
background read calls it. It is not marked destructive, because Arcade never said it destroys
anything: that marker is what makes a call ask as deleting does (see [Approvals](../approvals.md)),
and it stays for the actions Arcade flags, such as `Attio.RemoveFromList`. A Composio action with no
label is recorded the same way. Where a curated toolkit exists for the app, enable that one.

**与上游不同: nothing warns before an unclassified toolkit is enabled.** Upstream's directory page
shows how many of a toolkit's actions are classified and warns before the administrator finishes.
This fork's picker shows neither: the count is computed for Arcade's catalogue and the page does not
draw it. Look at the app's actions after adding it.

## Least privilege is not an Arcade property

Do not tell anybody that Arcade gives least-privilege access. It is true for some providers and
false for others, and the same product is on both sides of the line.

What a consent _covers_ depends on whether the provider issues per-request scopes. _Measured_ by
upstream, by hand, through a completed consent to a single action, from a clean baseline:

| Provider                  | Scopes per action                                   | One read consent authorized | Isolation |
| ------------------------- | --------------------------------------------------- | --------------------------- | --------- |
| Google (`Gmail`)          | `gmail.readonly` vs `gmail.send` vs `gmail.compose` | **11 of 30**                | yes       |
| GitHub (via a GitHub App) | **none, for any action**                            | **43 of 43**                | no        |

On Google, consenting to a read authorizes the reads that share its scope and nothing that sends.
On GitHub, consenting to `Github.CountStargazers` — **a read** — flipped all 43 actions to
authorized, **the writes and the destructive one included**, because a GitHub App's permissions are
fixed when the app is registered, and no request can ask for fewer.

> **Least privilege is a property of (provider × how its OAuth app was registered), not of Arcade.**

**与上游不同: this fork cannot ask for less than the whole app.** Upstream measures which case an
app is, says so before anybody grants anything, and lets a person on a provider with per-request
scopes approve one action at a time. Here **Connect asks for every scope the app publishes** and
there is no narrower consent, so when somebody asks whether connecting an app "only lets it read",
the answer is no: connecting gives the deployment everything the app's actions ask for, and what a
Bot may do with it is the tool grant.

## Scope versus tool grant

Two different questions are easily run together, and an operator will be asked both:

- **Scope** answers _"may this deployment ever read your mail?"_ It is the provider's, it is given
  when somebody consents, and it stays until it is withdrawn at the provider.
- **The tool grant** answers _"may **this Bot** call `ListThreads`?"_ It is an administrator's
  decision, made per Bot, per action.

**Only the second is OpenBot's to give and take instantly**, and no consent widens it. Somebody
consenting to a broad scope does not hand any Bot more actions; a Bot with no grant for an action
cannot call it however much the account allows. In this fork the tool grant is the entire narrowing
on every provider — the same position as Composio's.

## `provider_id` means three different things

An operator reading an Arcade dashboard, or an API response, or a refusal this deployment quotes,
will meet the field `provider_id` on three different objects — and it means something different on
each. _Measured_ by upstream in its 2026-10-13 live-suite run:

| Where you are reading it                         | What it is                                      | Example                              |
| ------------------------------------------------ | ----------------------------------------------- | ------------------------------------ |
| A **tool** listing, `requirements.authorization` | the provider **type** — the vendor              | `google`                             |
| A **user connection** row                        | the provider **instance** — a configuration     | `google-openbot`, `cpk-poc`          |
| An **auth provider** config                      | `id` is the instance, `provider_id` is the type | `id: arcade-google` of type `google` |

The auth-provider config is the only bridge between the other two. Verbatim, from that run:

```
{"id":"cpk-poc",        "provider_id":"github", "type":"oauth2", "status":"active"}
{"id":"google-openbot", "provider_id":"google", "type":"oauth2", "status":"active"}
{"id":"arcade-google",  "provider_id":"google", "type":"oauth2", "status":"active"}
```

A connection row carries **no vendor-type field at all**. Its full key set, verbatim:

```
id, provider_type, connection_id, connection_status, scopes, user_id, provider_id,
provider_description, provider_user_info
```

`provider_type` there is `"oauth2"` — the auth **scheme**, not the vendor. So the instance id is the
only thing on a connection that says which vendor it belongs to, and the only way from a tool's
`google` to a person's row is through the list of configured providers of type `google`.

**This bit upstream once**, and the fix came here with the adapter. A connection lookup compared a
tool's type against a row's instance — `"google"` against `"google-openbot"` — and so matched
nothing on every real deployment. It did not present as an error: a connection that existed read as
**not connected**. **If a connection you can see in Arcade's dashboard looks absent in OpenBot,
check that the provider the person connected under is one this project has configured** — a provider
configuration deleted while somebody's connection outlived it reads the same way, and deliberately
so: OpenBot leaves a row it cannot attribute alone rather than guess which vendor it belongs to.

## Disconnecting one app may end another

Arcade's connections are per **auth provider**, not per app, and the sharing was _measured_ by
upstream rather than inferred: in its 2026-10-13 live-suite run the provider behind both `Gmail` and
`GoogleCalendar` was the single type `google`, named after neither toolkit. One Google connection
serves them both, and **no narrower instrument exists** — there is nothing to disconnect that ends
only one of them. **Somebody disconnecting Gmail can end their Calendar**, in production, today.

Two _Shared_ apps that both use Google do **not** share a connection, because each Shared app has
its own randomly minted identity at Arcade — disconnecting one does not touch the other.

**与上游不同: the person is not told beforehand.** Upstream names the apps that would end with the
connection before somebody confirms a disconnect. This fork reconciles afterwards: once a person's
disconnect has gone through, each of their other Arcade apps on the same auth provider that Arcade
now also reports as not connected has its row here ended too, with its own audit entry, and the
response lists them (`siblings`). The page does not show that list. An app Arcade could not be asked
about keeps its row (`arcade-sibling-not-cleared` in the log); pressing Disconnect again is the
retry. An administrator removing an app does not run this reconciliation.

## Revoking at Arcade is not revoking at the provider

Upstream's page records that Google's consent screen is reached with `include_granted_scopes=true`,
so **grants accumulate on the account**. Somebody who consents to a read and later to a write holds
both at Google, as one grant.

Disconnect deletes the Arcade connection. That ends **this deployment's** ability to act; what the
provider then does with the standing grant happens out of sight. **Nobody should read Disconnect as
"my Google account no longer trusts this."** The person who wants that has to withdraw the grant at
the provider itself, and an operator asked about it should say so rather than reassure.

## The Re-check path, and what a row's date means

Composio has a one-call probe, `askAction`, that verifies a key and which Re-check runs again.
**It is Composio's own. Arcade has no counterpart.** Every Arcade app either connects by consent or
needs no account, and pressing **Re-check** on either **refuses** rather than spending a call.

**与上游不同: an Arcade row here is written as verified, dated the day the consent completed.**
Upstream writes no `verified_at` for an Arcade connection. This fork's return leg records the row as
verified, with that moment as its date and no probe action, the way a Composio app connected at a
consent screen is recorded; a Shared app's team account is recorded the same way on its app row. The
date is when somebody finished consenting, not the last time anything was checked.

What is asked of Arcade afterwards is only whether the connection is still there, when a page opens
the app: a no clears the row, a yes changes nothing. This fork has no per-action state to show (see
above), so nothing here says which actions an account has authorized.

## A consent coming back for the wrong person

A consent that completes but belongs to a different identity than the attempt it is returning to is
refused, and nothing is written either way. **What Arcade answers in that case carries no reason**:
_measured_ by upstream in its 2026-10-13 live-suite run, confirming a return as the wrong user
answers a generic `400`, `coordinator_error`, message `"Bad request"`, with nothing in it that names
an identity mismatch.

So the refusal a person lands on is the ordinary `vendor-unavailable` one, not
`not-your-authorization`, which is kept for an answer Arcade names as a mismatch and for an
authorization id or account that does not match the attempt. That is a worse message and nothing
more: the attempt row is left untouched, and the returning authorization is in any case compared to
the id this deployment minted, which is the check that actually binds the return leg to the attempt.
An operator shown `vendor-unavailable` on a consent that seemed to complete should consider the
wrong-account case among the causes, because the vendor will not say.

## 与上游不同: the whole list

Everything above that is marked, in one place:

1. **Approving one action at a time is not merged**, nor the list of what an account has
   authorized. Connect asks for the whole app, an app whose actions need more than one auth
   provider instance cannot be connected, and least privilege cannot be had through the consent.
2. **A grant left behind by a cancelled attempt**: a Shared app's team account is revoked at Arcade;
   a person's own is only recorded in the audit trail (`mcp.cancelled_grant_left_live`).
3. **Cancelled and no-longer-permitted returns are judged before Arcade is asked to confirm**, so
   those consents never take effect at Arcade.
4. **A grant Arcade already holds is not adopted.** Connect answers an error when Arcade holds a
   grant this deployment has no row for; revoke it in Arcade's dashboard, then connect again.
5. **A member is never shown the broker's name**, so a verifier pointing elsewhere reads to the
   person as a generic failure and the address is in the startup warning and the log.
6. **No Reconnect card or button**: a call Arcade refuses for want of authorization simply fails,
   and connecting again is Disconnect, then Connect.
7. **Siblings are reconciled after a disconnect, not named before it**, and not when an
   administrator removes an app.
8. **An Arcade row is written verified, dated the day of the consent.**
9. **Nothing warns before an unclassified toolkit is enabled.**
10. **Pages and tables**: one directory page (`/admin/plugins/composio`), connections under
    `/settings/connected-accounts`, rows in `composio_connections` and on `mcp_servers`; the return
    leg's reason is not yet shown as a sentence; Composio's "deployment's own OAuth client" answers
    409 on Arcade.
11. **None of upstream's live measurements has been repeated by this fork.**

## What is unproven

The measurements above were taken by upstream, by hand, against a live Arcade project, when and how
the top of this page says; none is re-checked by CI, and this fork has not taken them again, so each
holds as of its date and for upstream's build. What was never observed at all is listed here.

- **The agentic-client checkbox was not exercised.** Google's _"Use this client for an AI-powered
  agent"_ declaration was deliberately left unticked for the measurements, so that it was not a
  variable in them. Its effect on consent, scopes or policy here is not known; see the deployer note
  above.
- **The wording of Arcade's dashboard is not described here.** This page says to set the project's
  verifier to the address above and to revoke a user's connection there, and does not name the
  dashboard's fields or screens, which were not checked against it and may change. The address
  itself is this deployment's.
- **An Arcade deployment of this fork end to end against a live project.** The fork's own tests
  drive the adapter, the routes and the store against stand-ins for Arcade.

## See also

- [Composio](composio.md) — the other broker; Personal and Shared apps, approvals and audit work the
  same way.
- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — the deployment's settings.
