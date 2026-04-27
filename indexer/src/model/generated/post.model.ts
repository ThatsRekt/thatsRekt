import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, Relation as Relation_, DateTimeColumn as DateTimeColumn_, StringColumn as StringColumn_, IntColumn as IntColumn_, BooleanColumn as BooleanColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {Whitelister} from "./whitelister.model"
import {PostAttacker} from "./postAttacker.model"
import {PostVictim} from "./postVictim.model"
import {Vote} from "./vote.model"
import {Edit} from "./edit.model"

@Entity_()
export class Post {
    constructor(props?: Partial<Post>) {
        Object.assign(this, props)
    }

    /**
     * postId from the contract
     */
    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Whitelister, {nullable: true})
    poster!: Relation_<Whitelister>

    /**
     * poster-supplied — block.timestamp of the malicious tx itself
     */
    @DateTimeColumn_({nullable: false})
    attackedAt!: Date

    /**
     * updated on amendNote / addAttackers / addVictims; mirrors on-chain field
     */
    @DateTimeColumn_({nullable: false})
    lastUpdatedAt!: Date

    /**
     * latest note text — historical edits captured in Edit entities
     */
    @StringColumn_({nullable: false})
    note!: string

    @IntColumn_({nullable: false})
    upvotes!: number

    @IntColumn_({nullable: false})
    downvotes!: number

    @IntColumn_({nullable: false})
    netScore!: number

    @BooleanColumn_({nullable: false})
    removed!: boolean

    @IntColumn_({nullable: false})
    createdAtBlock!: number

    @DateTimeColumn_({nullable: false})
    createdAtTimestamp!: Date

    @IntColumn_({nullable: true})
    removedAtBlock!: number | undefined | null

    @DateTimeColumn_({nullable: true})
    removedAtTimestamp!: Date | undefined | null

    @OneToMany_(() => PostAttacker, e => e.post)
    attackerLinks!: Relation_<PostAttacker[]>

    @OneToMany_(() => PostVictim, e => e.post)
    victimLinks!: Relation_<PostVictim[]>

    @OneToMany_(() => Vote, e => e.post)
    votes!: Relation_<Vote[]>

    @OneToMany_(() => Edit, e => e.post)
    edits!: Relation_<Edit[]>
}
