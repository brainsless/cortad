// Which listening port is the app. A database that answers an HTTP probe on its own port is not the
// app: MongoDB says so in words, and AI Answers' run followed its in-memory MongoDB after a restart
// and sent every trial there. A database's own address in the log (mongodb://127.0.0.1:52011) names
// the store, never the app.
const NOT_AN_APP = /trying to access MongoDB over HTTP|^-ERR |^\$\d+\r?\n|^\+PONG/m;
const STORE_URL = /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|redis|rediss|mysql|mariadb|amqp|nats):\/\/\S+/gi;

export const notAnApp = (head) => NOT_AN_APP.test(head);
export const withoutStores = (log) => log.replace(STORE_URL, "");
