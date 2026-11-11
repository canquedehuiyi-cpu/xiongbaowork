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
| Each person      | Connects their own account to that app                       | `/connections`                                                                   |

The key is an environment variable and nothing else, as Composio's is. No administrator can turn
Arcade on from a page. The Helm chart has a value for Composio's key (`secrets.composioApiKey`) and
none for Arcade's.

**与上游不同.** Upstream has a directory page of its own for Arcade (`/admin/plugins/arcade`).
This fork has one directory page, `/admin/plugins/composio` (浏览应用), which lists whichever broker
is active, Arcade's toolkits included. People connect on 连接, `/connections`, as upstream's do; the
old `/settings/connected-accounts` address redirects there, so a consent begun before the move still
comes back. An enabled Arcade app is the row
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
  连接, an administrator disconnects a Shared app's team account, or an administrator removes
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
sent on to the app's page under 连接 (`/connections`), or to the list with a reason beside it if the consent
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

- **A Shared app's team account that was not yet connected is revoked at Arcade.** The team
  identity is minted at random for each app and each switch to Shared, so revoking it cannot take
  another app with it. Only Arcade answering that it revoked counts; if it finds nothing or fails,
  the grant is recorded in the audit trail instead, as below. **One that was already connected** (a
  reconnection in place, or an action authorized on it) is not revoked: revoking ends the team
  identity's whole connection, the one everybody's calls run on, while the app would still read as
  connected. The grant is recorded instead (`cancelled-left-live`), as upstream does.
- **A person's second-account consent is revoked at Arcade.** The further id was minted for that
  press and holds nothing else, so revoking it ends nothing else.
- **A person's own account is revoked where that takes nothing else with it**, as upstream does.
  Revoking ends the person's connection for that auth provider (see
  [Disconnecting one app may end another](#disconnecting-one-app-may-end-another)), so it is done
  only when the app had no connection before this consent and no other app of theirs is on the same
  auth provider. Where the app was already connected, another app shares the connection, a
  provider could not be read, or Arcade does not confirm the withdrawal, the grant is left and
  recorded: an `mcp.cancelled_grant_left_live` audit entry, and the person is told
  (`cancelled-left-live`).

A refused return lands on `/connections?authorized=<reason>`. The reasons this fork answers are
`no-broker`, `missing-handle`, `no-attempt`, `cancelled`, `not-permitted`, `vendor-unavailable`,
`not-your-authorization`, `authorization-failed`, `not-finished`, `name-changed`,
`cancelled-left-live` and `not-recorded`, the same words upstream uses. The page shows each as a
sentence (the personal edition has its own words for the ones that would send somebody to an
administrator). Neither the consent link nor anything Arcade answered is ever put in a
response, a log line or the audit trail; the link is a bearer credential and a status answer carries
an access token.

## What an administrator does

The shape is Composio's: enable an app, grant its actions to a Bot, and each person connects their
own account (or an administrator connects a Shared app's team account, which goes through the same
consent and return leg under the deployment's identity, and still needs shared use approved for each
Bot before a call goes out on it). Two things are different and worth reading before pressing
**Add**.

### Connect asks for the whole app, and each action can still be approved alone

**Connect works as it does on Composio.** It asks Arcade for one consent covering every scope the
app's actions publish (the `auth.authorize` call, with the app's own authorization requirement read
off its listing), and the consent comes back through the verifier above, which records the
connection and lands the person on the app's page under 连接. That is where it lands
whichever page Connect was pressed on. Actions name the same requirement when they name the same
auth provider instance, its `id` (or the same `provider_id` where none names an `id`): the live
catalogue publishes one instance with and without its `provider_id` (`SquareupApi`) and two
instances with neither (`XeroApi`).

The connection is a row in this deployment's `composio_connections`, as Composio's are: a Bot's call
needs that row before it reaches Arcade, a page that opens the app asks Arcade whether the
connection is still there and clears the row when it is not, and Disconnect ends it at Arcade and
then here. Arcade still checks each action itself on every call.

**Each action can still be approved alone**, for somebody who wants to grant less than the whole
app. `GET /api/plugins/servers/:id/grants` answers what the account holds for each action
(`authorized`, `needs-consent` with the scopes it would ask for, `needs-operator` naming a secret
the deployment has to set first, or `unknown`), and `POST /api/plugins/servers/:id/authorize` with
`{ "action": "<the action's name at Arcade>" }` starts a consent for that one action. A
`needs-operator` entry names the deployment secrets it waits for (`missing`) to an administrator
only; anybody else sees the state with an empty list. The action has
to be one the app publishes, spelled as Arcade spells it (`Gmail.SendEmail`, case and all). The
consent comes back through the same verifier, bound to whoever pressed it, records the connection
and lands on the app's page with `?action=<name>`. `GET /api/plugins` says `authorizesPerAction:
true` where these routes are live, which is where Arcade is the wired broker. Both the list and the
consent are for the account the person's calls run in: their default account, which is their
second one if they made it the default. Two things follow:

- On a provider with per-request scopes, approving actions one at a time is how a person grants
  less than the whole app; see [Least privilege](#least-privilege-is-not-an-arcade-property).
- **与上游不同:** an app whose actions name more than one auth provider instance, or whose
  provider cannot be read, is refused by Connect and by Authorize alike, before anything is minted.
  Upstream authorizes such an app one action at a time; here a connection made that way could not
  be disconnected, confirmed or listed, because each of those has to know which provider the
  connection is held under, and Arcade's answer for such an app is a refusal.

A Shared app's team account is read and authorized by an administrator only, and only one who holds
the admin capability at that moment: a session that says admin after the role was taken away is
refused before Arcade is asked anything. **与上游不同:** upstream lets any member read a Shared
app's grant list (and refuses only the mint); here both are the administrator's.

**Where Arcade already holds everything the app asks for, Connect records the connection without a
consent screen**, and answers `{ "connected": true }` instead of a link. That happens only on the
press itself: the grant is filed under the person's own name at Arcade, which only their own
session can mint, so it is something they consented to. **与上游不同:** a page that opens the app
does not record a grant with no row here (upstream does); the confirm a page runs on load only
refreshes a connection that already exists, because anybody opening a page can trigger it.

**与上游不同: a Shared app's team account is never adopted.** Where Arcade holds a grant under the
team identity and the app has no team account recorded, nothing here can say who consented to it:
it may be left from a connect that was cancelled or refused, by somebody who is no longer an
administrator, with a mailbox of their own. So Connect by an administrator first revokes it at
Arcade (the team identity is minted per app, so nothing else goes with it) and then starts a new
consent, which that administrator finishes in their own session. If the grant cannot be revoked,
Connect is refused and nothing is recorded.

**A person can hold a second account at an app.** Arcade keeps one account per user id and auth
provider, so a person's second account at an app (**Connect another account**,
`POST /servers/:id/connect?another=1`) is filed there under a further id of theirs,
`<their id>~<suffix>`, with a random suffix minted by the server when they press it. The return leg
is the same one: only the session that pressed it can finish it. The connection row stays under the
person's own id and the further account is recorded beside it in `brokered_accounts`; the app's page
lists both by the address the provider reported. A Bot's call that names one of them runs in that
account, a call that names none runs in the person's default one, and a name the person does not
hold is refused before Arcade is asked. Where a row has no address yet, a name that matches nothing
first reads Arcade's account list once to fill addresses in. That read adds and fills in rows and
never forgets one (an account Arcade does not list at that moment may only have lapsed, and the
sweeps below find accounts by their rows), and it is made at most once in ten minutes for the same
person, app and rows, so a model that keeps naming the wrong account does not ask Arcade each time.
A read Arcade did not answer does not count, so the next name asks again.
Only the accounts page forgets an account Arcade no longer lists. Disconnecting one account withdraws that one; disconnecting
the app, offboarding the person or removing the app withdraws every account they hold there. A
Shared app has one team account and no second one.

**A call Arcade refuses for want of authorization shows the person the Reconnect card.** The
refusal carries the connect-app marker with `reason: "reconnect"` (`"shared"` for a team account,
which an administrator reconnects) and the time of the refusal. The connection row is ended only
where Arcade then answers that the account holds nothing for the app; where it holds the app's
other actions, which is what approving one action at a time leaves, or does not answer in time,
the row stays and those actions go on working. Reconnect is Connect again:
`POST /servers/:id/connect` over a connection that stands asks for the whole app under the same
account, with no Disconnect first, and when the consent comes back the connection's date moves
forward so the card stops offering it. Where the refused call ran in the person's second account,
the card names that account (`account`, the row id from the accounts page), and
`POST /servers/:id/connect?account=<id>` reconnects that account rather than the person's own one.
It does so also where Arcade answers that the second account holds nothing any more: its row is kept
rather than forgotten, so Reconnect asks consent for the same id and brings that account back,
instead of landing on the person's own account (which may hold everything and answer
`{ "connected": true }`). If that account was the default, the default passes to an account Arcade
says is still connected, the person's own one first, as upstream falls back, so a call naming no
account runs there; a call naming the lost account still gets the card that reconnects it, and a
reconnected account does not take the default back by itself. Other lost accounts are kept too, so
they are never chosen; where none is confirmed alive, or Arcade does not answer, the default stays
where it is and calls keep getting the card. A row id that is not the person's own on that app answers 404 and mints
nothing. The accounts page still forgets the row if Arcade stops listing the account; Reconnect
from a card whose row is gone answers 404 with a sentence pointing to **Connect another account**.
A connected Shared app is reconnected in place the same way, by an administrator; its connection
date moves forward and the administrator who connected it first stays on record.

**An app whose every account is gone at Arcade has its account rows forgotten with its connection**,
and the accounts page of an app the person has no connection on lists nothing. An old row there
would otherwise offer a Disconnect that ends the person's connection to a different app on the same
auth provider.

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

**The directory says how much of a toolkit is classified.** Each app in `GET /composio/apps`
carries `actionCount`, `classifiedCount`, `permissionCount` and `scopedActionCount` (the last three
`null` where the broker does not report them, as on Composio), so the page can warn before an
administrator enables a toolkit most of whose actions carry no label. The directory draws that
warning on an app none of whose actions is classified, and says how many separate permissions its
consent spans.

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

So when somebody asks whether connecting an app "only lets it read", the answer is whatever that
app's measurement says, not what Arcade says in general. **Connect asks for every scope the app
publishes**, so least privilege on a provider that has it means approving actions one at a time
(`POST /servers/:id/authorize`) instead. Before sending somebody to the consent screen for one
action, the app's grant list names the permission being asked for and lists the other actions that
share it, as upstream's does; it never promises that only the named action becomes usable.

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

**The apps that would end are named beforehand.** `GET /servers/:id/connection/siblings` answers
the person's other apps on the same auth provider, and how many could not be asked about, so the
page can say what a disconnect takes with it. After the disconnect, each of those that Arcade now
also reports as not connected has its row here ended too, with its own audit entry, and the
response lists them (`siblings`). An app Arcade could not be asked about keeps its row
(`arcade-sibling-not-cleared` in the log); pressing Disconnect again is the retry. **An
administrator removing an app, or switching it to a Shared account, runs the same reconciliation**
for every person whose connection that revoked, and so does disconnecting an account on the
accounts page: their other apps on that auth provider that Arcade no longer holds are ended, each
with an audit entry naming the app it ended with (`endedWith`).

**A second account is never left behind by a sweep.** Where the person's own account is gone at
Arcade but a second account still lives, the connection stays (the page reads connected, and a call
can name the second account), a call refused on the person's own account forgets only that
account (one refused on a second account keeps its row, for Reconnect above), and a
sibling cascade leaves such an app connected. Offboarding, removing an app and switching it to
Shared also find accounts recorded in `brokered_accounts` whose connection row is already gone.
Offboarding withdraws all of them. Removing and switching withdraw only the second accounts: the
person's own name has no connection on that app, and withdrawing it would end their other apps on
the same auth provider. Opening an app's accounts page records nothing for somebody with no
connection on it, because Arcade lists connections per auth provider, not per app.

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
the app: a no clears the row, a yes changes nothing. Which actions an account has authorized is read
from Arcade when the app's grant list is opened (`GET /servers/:id/grants`), not from the row's date.

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

1. **A grant Arcade holds with no connection here is recorded only on the person's own Connect**,
   never by a page loading; and a Shared app's team account is never adopted: it is revoked and
   consented to again by the administrator who presses Connect.
2. **Cancelled and no-longer-permitted returns are judged before Arcade is asked to confirm**, so
   those consents never take effect at Arcade.
3. **A member is never shown the broker's name**, so a verifier pointing elsewhere reads to the
   person as a generic failure and the address is in the startup warning and the log.
4. **An Arcade row is written verified, dated the day of the consent.**
5. **An app whose actions name more than one auth provider instance is neither connected nor
   authorized one action at a time.**
6. **A Shared app's grant list is read by an administrator only**, as its per-action Authorize is;
   upstream lets any member read it.
7. **Pages and tables**: one directory page (`/admin/plugins/composio`), rows in
   `composio_connections` and on `mcp_servers`; Composio's "deployment's own OAuth client" answers
   409 on Arcade.
8. **None of upstream's live measurements has been repeated by this fork.**

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
