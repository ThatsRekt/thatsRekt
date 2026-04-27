import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class Upgrade {
    constructor(props?: Partial<Upgrade>) {
        Object.assign(this, props)
    }

    /**
     * txHash-logIndex
     */
    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    newImplementation!: string

    @IntColumn_({nullable: false})
    blockNumber!: number

    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @StringColumn_({nullable: false})
    txHash!: string
}
