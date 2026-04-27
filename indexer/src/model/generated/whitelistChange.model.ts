import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, Relation as Relation_, BooleanColumn as BooleanColumn_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_, StringColumn as StringColumn_} from "@subsquid/typeorm-store"
import {Whitelister} from "./whitelister.model"

@Entity_()
export class WhitelistChange {
    constructor(props?: Partial<WhitelistChange>) {
        Object.assign(this, props)
    }

    /**
     * txHash-logIndex
     */
    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Whitelister, {nullable: true})
    addr!: Relation_<Whitelister>

    @BooleanColumn_({nullable: false})
    added!: boolean

    @IntColumn_({nullable: false})
    blockNumber!: number

    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @StringColumn_({nullable: false})
    txHash!: string
}
