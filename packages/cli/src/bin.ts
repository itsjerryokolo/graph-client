import { graphqlClientCLI } from '.'

graphqlClientCLI().catch((err) => {
  console.error(err)
  process.exit(1)
})
