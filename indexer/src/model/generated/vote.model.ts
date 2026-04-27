import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, Relation as Relation_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_, StringColumn as StringColumn_} from "@subsquid/typeorm-store"
import {Post} from "./post.model"
import {Whitelister} from "./whitelister.model"
import {VoteDirection} from "./_voteDirection"

@Entity_()
export class Vote {
    constructor(props?: Partial<Vote>) {
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
    voter!: Relation_<Whitelister>

    /**
     * previous vote direction at the time of this event (None if first vote)
     */
    @Column_("varchar", {length: 8, nullable: false})
    oldDirection!: VoteDirection

    /**
     * new vote direction emitted by the contract (None on unvote)
     */
    @Column_("varchar", {length: 8, nullable: false})
    newDirection!: VoteDirection

    @IntColumn_({nullable: false})
    blockNumber!: number

    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @StringColumn_({nullable: false})
    txHash!: string
}
