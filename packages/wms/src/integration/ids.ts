/** 连接器、端点、路由的 id。配置校验和本机库共用。 */
export const CONNECTOR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 密钥引用名。配置里只出现这个名字，值在本机密钥库。 */
export const SECRET_REF_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;
