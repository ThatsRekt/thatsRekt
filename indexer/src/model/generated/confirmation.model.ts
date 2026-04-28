import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, Relation as Relation_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_, StringColumn as StringColumn_} from "@subsquid/typeorm-store"
import {Post} from "./post.model"
import {Whitelister} from "./whitelister.model"
import {ConfirmDirection} from "./_confirmDirection"

@Entity_()
export class Confirmation {
    constructor(props?: Partial<Confirmation>) {
        Object.assign(this, props)
    }

    /**
     * txHash-logIndex
     */
    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Post, {nullable: true})
    post!: Relation_<Post>

    @Index_()
    @ManyToOne_(() => Whitelister, {nullable: true})
    confirmer!: Relation_<Whitelister>

    /**
     * previous confirm direction at the time of this event (None if first confirmation)
     */
    @Column_("varchar", {length: 4, nullable: false})
    oldDirection!: ConfirmDirection

    /**
     * new confirm direction emitted by the contract (None on unconfirm)
     */
    @Column_("varchar", {length: 4, nullable: false})
    newDirection!: ConfirmDirection

    @IntColumn_({nullable: false})
    blockNumber!: number

    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @StringColumn_({nullable: false})
    txHash!: string
}
