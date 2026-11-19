import { envName } from "../../../shared/env-aliases";
import { BROKERED_PROFILE, type BrokerProvider } from "./access";
import { type ProviderDecision, providerDecision } from "./broker";

/**
 * 入口处的提供商决定（上游 #770 / #1017），厂商构造函数从外面传进来：这个文件不引入任何厂商包，
 * 测试不用启动服务、不用发请求就能回答。
 *
 * 与上游的差异：fork 的 Composio 工厂除了 `actions` 与 `broker` 还带 `guides`（#1297 密钥指引）和
 * `accounts`（#1298 逐个列账号），所以这里对工厂的返回值是泛型的，原样交回给 `index.ts`。
 */
type ClientFactory<Client, Options = undefined> = (
  apiKey: string,
  options: Options,
) => Client;

/**
 * Arcade 客户端除 key 外还要的：项目的用户验证地址必须指向哪里（不知道自己的公开地址时没有），
 * 以及这个安装是否拥有那个项目、因而可以把验证地址指向自己（见 {@link ownsBrokerProject}）。
 */
export type ArcadeClientOptions = {
  verifierUrl?: string;
  repointVerifier?: boolean;
};

/**
 * 这个安装是否拥有它的 broker 项目，也就是能不能改 Arcade 用户验证地址这样的项目级设置。
 *
 * 单用户安装可以：它在 broker 那边有自己的名字（`ensureSingleUserIdentity` 在第一次带着 broker 启动时
 * 给每一台一个），它唯一的人就是它的管理员，个人版就是这样的安装。要登录的部署把 key 所在的项目当作
 * 共享的，项目设置由管理员手动改，这里只检查。
 */
export function ownsBrokerProject(c: { singleUser?: boolean }): boolean {
  return c.singleUser === true;
}

/** 工厂至少交回的两样：传输层的 actions 与 broker。fork 的 Composio 工厂还带别的，原样保留在 `clients` 里。 */
type BuiltClient = { actions: unknown; broker: unknown };

export type ProviderWiring<C extends BuiltClient, A extends BuiltClient> = {
  /** 唯一活动的提供商；合法地没有 broker 的部署为 `null`。 */
  provider: BrokerProvider | null;
  /** 交给 store 和路由的那一个 broker；正好在 `provider` 为 null 时为 null。 */
  broker: C["broker"] | A["broker"] | null;
  /** 两个传输层的接缝，总是两个都在：不活动的那个明确是 `null`。 */
  install: { composio: C["actions"] | null; arcade: A["actions"] | null };
  /** 构造出来的完整客户端，只有活动的那一个。 */
  clients: { composio: C | null; arcade: A | null };
};

/**
 * 按配置选出一个提供商，只构造它的客户端。
 *
 * `misnamed` 和 `ambiguous` 直接拒绝而不是降级成「没有 broker」：那样的故障启动时没人知道，
 * 很久以后才表现为功能不工作。拒绝里只说变量名，从不说值。`unconfigured`（一个 key 都没配）
 * 是唯一接到「什么都没有」的情况。
 *
 * 不设 `OPENBOT_BROKER_PROVIDER`、只配 `COMPOSIO_API_KEY` 时，构造的就是以前那一个 Composio 客户端。
 */
export function selectProviderWiring<
  C extends BuiltClient,
  A extends BuiltClient,
>(
  c: {
    composioApiKey?: string;
    arcadeApiKey?: string;
    brokerProvider?: BrokerProvider;
    /** 这个部署的公开地址，Arcade 的验证地址必须指向它。见 `config.ts`。 */
    publicUrl?: string;
    /** 单用户模式：broker 项目归这个安装自己。 */
    singleUser?: boolean;
  },
  create: {
    composio: ClientFactory<C>;
    arcade: ClientFactory<A, ArcadeClientOptions>;
  },
): ProviderWiring<C, A> {
  const decision = providerDecision(c);
  if (decision.kind === "misnamed") {
    const keyName = BROKERED_PROFILE[decision.named].envVar;
    throw new Error(
      `${envName("BROKER_PROVIDER")}=${decision.named} 指明的提供商没有配置 ${keyName}。请把 ${keyName} 设为这个部署的 key，或者修改、去掉 ${envName("BROKER_PROVIDER")}。`,
    );
  }
  if (decision.kind === "ambiguous") {
    throw new Error(
      `COMPOSIO_API_KEY 和 ARCADE_API_KEY 都设置了，但没有设 ${envName("BROKER_PROVIDER")}，所以没有任何提供商是活动的，所有连接应用都不会工作。请把 ${envName("BROKER_PROVIDER")} 设为 composio 或 arcade 指明在用哪一个，或者去掉不用的那个 key。`,
    );
  }
  if (decision.kind === "unconfigured") {
    return {
      provider: null,
      broker: null,
      install: { composio: null, arcade: null },
      clients: { composio: null, arcade: null },
    };
  }
  const provider = decision.provider;
  if (provider === "arcade") {
    const verifierUrl = arcadeVerifierAddress(c.publicUrl);
    const client = create.arcade(
      requiredKey(provider, c.arcadeApiKey, "ARCADE_API_KEY"),
      verifierUrl ? { verifierUrl, repointVerifier: ownsBrokerProject(c) } : {},
    );
    return {
      provider,
      broker: client.broker,
      install: { composio: null, arcade: client.actions },
      clients: { composio: null, arcade: client },
    };
  }
  const client = create.composio(
    requiredKey(provider, c.composioApiKey, "COMPOSIO_API_KEY"),
    undefined,
  );
  return {
    provider,
    broker: client.broker,
    install: { composio: client.actions, arcade: null },
    clients: { composio: client, arcade: null },
  };
}

/** 选中的提供商必须有的 key，用断言而不是测试：两边一旦不一致，启动时就说出来，而不是悄悄不接线。 */
function requiredKey(
  provider: BrokerProvider,
  apiKey: string | undefined,
  keyName: string,
): string {
  if (apiKey !== undefined) return apiKey;
  throw new Error(
    `选中了 ${provider} 作为 broker，但 ${keyName} 没有设置。这是提供商选择的程序错误，不是配置错误；没有接上任何 broker。`,
  );
}

/**
 * 这个部署的存储读写哪一个提供商的连接，与「哪个 broker 是活动的」是两个问题。
 *
 * 先看配置，再看行，从不凭空挑一个厂商：配置指明了就是它；没指明（key 后来撤了）就看实际持有的行
 * 属于谁。两边都有行而没有活动的提供商，拒绝；一行都没有，答 composio——那只是空集合的标签。
 */
export function storedProvider(
  decision: ProviderDecision,
  rowOwners: BrokerProvider[],
): BrokerProvider {
  if (decision.kind === "active") return decision.provider;
  if (decision.kind === "misnamed") {
    throw new Error(
      `${envName("BROKER_PROVIDER")}=${decision.named} 指明的提供商没有设置 ${BROKERED_PROFILE[decision.named].envVar}。`,
    );
  }
  const owners = [...new Set(rowOwners)];
  if (owners.length > 1) {
    const counted = owners
      .map((owner) => BROKERED_PROFILE[owner].vendor)
      .join(" 和 ");
    throw new Error(
      `这个部署在 ${counted} 都持有连接，而没有任何配置说明哪一个是活动的：${
        decision.kind === "ambiguous"
          ? `${decision.configured.map((p) => BROKERED_PROFILE[p].envVar).join(" 和 ")} 都设置了，${envName("BROKER_PROVIDER")} 没有设置`
          : "没有设置任何 broker 的 API key"
      }。两边都持有时，这个部署里没有办法结束它们：只要另一边还有连接，启用任何一边都会被拒绝。请在其中一个厂商自己的后台结束那边的账号，手动删除对应的连接行，再把 ${envName("BROKER_PROVIDER")} 设为另一个。`,
    );
  }
  const owner = owners[0];
  if (owner !== undefined) return owner;
  return "composio";
}

/**
 * Arcade 自定义用户验证地址必须指向的路径：插件路由挂在 `/api/plugins`（`app.ts`），验证路由是
 * 其上的 `/arcade/verify`（`routes.ts`）。
 */
export const ARCADE_VERIFY_PATH = "/api/plugins/arcade/verify";

/** 这个部署的验证地址；不知道自己的公开地址时为 undefined。重复去掉结尾斜杠，避免双斜杠。 */
export function arcadeVerifierAddress(
  publicUrl: string | undefined,
): string | undefined {
  const origin = publicUrl?.trim().replace(/\/+$/, "");
  return origin ? `${origin}${ARCADE_VERIFY_PATH}` : undefined;
}

/**
 * Arcade 部署启动时关于项目用户验证地址打印的一行；没什么要说时为 null。
 *
 * 拥有项目且知道自己地址的安装什么都不说：它每次授权前都把验证地址指向自己。要登录的部署把项目
 * 当作共享的，从不改它，所以说一次管理员要设成哪个地址——在项目指向这里之前「连接」会拒绝。
 * 不知道自己的地址时两样都做不了，说要设哪个变量。
 */
export function arcadeVerifierNotice(
  publicUrl: string | undefined,
  { ownsProject }: { ownsProject: boolean },
): string | null {
  const address = arcadeVerifierAddress(publicUrl);
  if (!address) {
    return `Arcade 是活动的 broker，但 ${envName("PUBLIC_URL")} 和 BETTER_AUTH_URL 都没有设置，这个部署不知道自己的公开地址，没法检查 Arcade 项目的用户验证地址是否是 <这个部署的公开地址>${ARCADE_VERIFY_PATH}。授权完成后会回到项目里填的那个地址，别的地址都是不存在的页面。请设置 ${envName("PUBLIC_URL")}。`;
  }
  if (ownsProject) return null;
  return `Arcade 是活动的 broker，这个部署需要登录，所以把 Arcade 项目当作共享的，从不修改项目的用户验证地址。每次授权前「连接」都会检查它，在它指向 ${address} 之前会拒绝。请在 Arcade 后台（Auth → Settings）把自定义验证地址设为这个地址。`;
}
